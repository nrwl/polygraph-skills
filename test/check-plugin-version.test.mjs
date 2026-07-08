import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  buildOutdatedMessage,
  checkPluginVersion,
  compareSemver,
  readFreshCachedLatest,
  resolveInstalledVersion,
} from '../source/hooks/check-plugin-version.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makePluginRoot(version, manifest = '.claude-plugin/plugin.json') {
  const root = makeDir('pg-plugin-root-');
  const manifestPath = join(root, manifest);
  mkdirSync(join(manifestPath, '..'), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify({ name: 'polygraph', version }));
  return root;
}

function makeFetch(latest, calls = []) {
  return async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ latest }),
    };
  };
}

function cacheFile(home, harness) {
  return join(home, '.polygraph', 'logs', `plugin-version-check-${harness}.json`);
}

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

test('compareSemver orders versions correctly', () => {
  assert.equal(compareSemver('0.2.33', '0.4.37'), -1);
  assert.equal(compareSemver('0.4.37', '0.2.33'), 1);
  assert.equal(compareSemver('0.4.37', '0.4.37'), 0);
  assert.equal(compareSemver('0.4.9', '0.4.10'), -1);
  assert.equal(compareSemver('1.0.0', '0.99.99'), 1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0-beta.1', '1.0.0-beta.2'), -1);
  assert.equal(compareSemver('not-a-version', '1.0.0'), null);
  assert.equal(compareSemver('1.0.0', undefined), null);
});

// ---------------------------------------------------------------------------
// resolveInstalledVersion
// ---------------------------------------------------------------------------

test('resolveInstalledVersion reads version from .claude-plugin/plugin.json', () => {
  const root = makePluginRoot('0.4.37');
  try {
    assert.equal(resolveInstalledVersion(root), '0.4.37');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInstalledVersion reads version from .codex-plugin/plugin.json', () => {
  const root = makePluginRoot('0.3.1', '.codex-plugin/plugin.json');
  try {
    assert.equal(resolveInstalledVersion(root), '0.3.1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInstalledVersion falls back to package.json', () => {
  const root = makePluginRoot('0.2.33', 'package.json');
  try {
    assert.equal(resolveInstalledVersion(root), '0.2.33');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveInstalledVersion returns null when no manifest exists', () => {
  const root = makeDir('pg-plugin-root-');
  try {
    assert.equal(resolveInstalledVersion(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkPluginVersion
// ---------------------------------------------------------------------------

test('outdated version emits message with versions and remediation', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  try {
    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37'),
    });
    assert.ok(message, 'expected a message');
    assert.ok(message.includes('0.2.33 installed'));
    assert.ok(message.includes('0.4.37 latest'));
    assert.ok(message.includes('claude plugins update polygraph@polygraph-plugins'));
    assert.equal(message, buildOutdatedMessage('claude', '0.2.33', '0.4.37'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex message includes codex remediation command', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33', '.codex-plugin/plugin.json');
  try {
    const message = await checkPluginVersion({
      harness: 'codex',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37'),
    });
    assert.ok(message.includes('npx @polygraph/codex-plugin@latest install'));
    assert.ok(message.includes('codex plugin add polygraph@polygraph-plugins'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('current version stays silent', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.4.37');
  try {
    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37'),
    });
    assert.equal(message, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed version newer than latest stays silent', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.5.0');
  try {
    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37'),
    });
    assert.equal(message, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry unreachable rejects without emitting a message', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  try {
    await assert.rejects(
      checkPluginVersion({
        harness: 'claude',
        pluginRoot: root,
        home,
        fetchImpl: async () => {
          throw new Error('network down');
        },
      }),
      /network down/
    );
    assert.ok(!existsSync(cacheFile(home, 'claude')), 'no cache written');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown installed version stays silent without fetching', async () => {
  const home = makeDir('pg-home-');
  const root = makeDir('pg-plugin-root-');
  const calls = [];
  try {
    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37', calls),
    });
    assert.equal(message, null);
    assert.equal(calls.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown harness stays silent', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  try {
    const message = await checkPluginVersion({
      harness: 'gemini',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37'),
    });
    assert.equal(message, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

test('fresh cache (<24h) skips the network fetch and still warns', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  const now = 1_000_000_000_000;
  const calls = [];
  try {
    mkdirSync(join(home, '.polygraph', 'logs'), { recursive: true });
    writeFileSync(
      cacheFile(home, 'claude'),
      JSON.stringify({ checkedAt: now - DAY_MS + 60_000, latest: '0.4.37' })
    );

    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('9.9.9', calls),
      now,
    });
    assert.equal(calls.length, 0, 'no network fetch with fresh cache');
    assert.ok(message.includes('0.4.37 latest'), 'uses cached latest');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale cache (>24h) triggers a fetch and refreshes the cache', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  const now = 1_000_000_000_000;
  const calls = [];
  try {
    mkdirSync(join(home, '.polygraph', 'logs'), { recursive: true });
    writeFileSync(
      cacheFile(home, 'claude'),
      JSON.stringify({ checkedAt: now - DAY_MS - 1, latest: '0.3.0' })
    );

    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37', calls),
      now,
    });
    assert.equal(calls.length, 1, 'fetch triggered for stale cache');
    assert.ok(message.includes('0.4.37 latest'));

    const cache = JSON.parse(readFileSync(cacheFile(home, 'claude'), 'utf8'));
    assert.equal(cache.latest, '0.4.37');
    assert.equal(cache.checkedAt, now);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt cache is treated as stale', () => {
  const home = makeDir('pg-home-');
  try {
    mkdirSync(join(home, '.polygraph', 'logs'), { recursive: true });
    writeFileSync(cacheFile(home, 'claude'), 'not json');
    assert.equal(readFreshCachedLatest('claude', home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end: run the hook script as a subprocess
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const hookSource = fileURLToPath(
  new URL('../source/hooks/check-plugin-version.mjs', import.meta.url)
);

function makeInstalledPlugin(version) {
  const root = makePluginRoot(version);
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const hookPath = join(root, 'hooks', 'check-plugin-version.mjs');
  writeFileSync(hookPath, readFileSync(hookSource));
  return { root, hookPath };
}

function runHook(hookPath, home, registry, harness = 'claude') {
  return execFileAsync(process.execPath, [hookPath, harness], {
    env: { ...process.env, HOME: home, npm_config_registry: registry },
  });
}

test('e2e: outdated plugin prints message to stdout and exits 0', async () => {
  const home = makeDir('pg-home-');
  const { root, hookPath } = makeInstalledPlugin('0.2.33');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ latest: '0.4.37' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const registry = `http://127.0.0.1:${server.address().port}`;
    const { stdout, stderr } = await runHook(hookPath, home, registry);
    assert.ok(stdout.includes('0.2.33 installed, 0.4.37 latest'));
    assert.ok(stdout.includes('claude plugins update polygraph@polygraph-plugins'));
    assert.equal(stderr, '');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: current plugin prints nothing and exits 0', async () => {
  const home = makeDir('pg-home-');
  const { root, hookPath } = makeInstalledPlugin('0.4.37');
  const server = createServer((req, res) => {
    res.end(JSON.stringify({ latest: '0.4.37' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const registry = `http://127.0.0.1:${server.address().port}`;
    const { stdout, stderr } = await runHook(hookPath, home, registry);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('e2e: unreachable registry prints nothing, exits 0, logs the failure', async () => {
  const home = makeDir('pg-home-');
  const { root, hookPath } = makeInstalledPlugin('0.2.33');
  try {
    const { stdout, stderr } = await runHook(hookPath, home, 'http://127.0.0.1:1');
    assert.equal(stdout, '');
    assert.equal(stderr, '');

    const log = readFileSync(join(home, '.polygraph', 'logs', 'hooks.log'), 'utf8');
    const entry = JSON.parse(log.trim().split('\n').at(-1));
    assert.equal(entry.hook, 'claude:check-plugin-version');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('successful check writes a cache with timestamp', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.4.37');
  const now = 1_000_000_000_000;
  try {
    await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37'),
      now,
    });
    const cache = JSON.parse(readFileSync(cacheFile(home, 'claude'), 'utf8'));
    assert.equal(cache.latest, '0.4.37');
    assert.equal(cache.checkedAt, now);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
