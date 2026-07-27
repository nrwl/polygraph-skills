import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
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
  isCacheFresh,
  readCache,
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
    assert.ok(message.includes('npx --prefer-online @polygraph/codex-plugin@latest install'));
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

test('registry unreachable rejects without emitting a message and negative-caches', async () => {
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

    const cache = JSON.parse(readFileSync(cacheFile(home, 'claude'), 'utf8'));
    assert.equal(cache.latest, null);
    assert.equal(cache.installed, '0.2.33');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('private registry 404/401 responses reject without emitting a message', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  try {
    for (const status of [404, 401]) {
      rmSync(cacheFile(home, 'claude'), { force: true });
      await assert.rejects(
        checkPluginVersion({
          harness: 'claude',
          pluginRoot: root,
          home,
          fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }),
        }),
        new RegExp(`registry responded ${status}`)
      );
      const cache = JSON.parse(readFileSync(cacheFile(home, 'claude'), 'utf8'));
      assert.equal(cache.latest, null, `status ${status} is negative-cached`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh negative cache skips the fetch and stays silent', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  const now = 1_000_000_000_000;
  const calls = [];
  try {
    mkdirSync(join(home, '.polygraph', 'logs'), { recursive: true });
    writeFileSync(
      cacheFile(home, 'claude'),
      JSON.stringify({ checkedAt: now - 60_000, installed: '0.2.33', latest: null })
    );

    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37', calls),
      now,
    });
    assert.equal(message, null);
    assert.equal(calls.length, 0, 'no fetch after a recent failed check');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('unparseable dist-tags latest is negative-cached and silent', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.2.33');
  const now = 1_000_000_000_000;
  try {
    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('not-a-version'),
      now,
    });
    assert.equal(message, null);

    const cache = JSON.parse(readFileSync(cacheFile(home, 'claude'), 'utf8'));
    assert.equal(cache.latest, null);
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
      JSON.stringify({
        checkedAt: now - DAY_MS + 60_000,
        installed: '0.2.33',
        latest: '0.4.37',
      })
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
      JSON.stringify({
        checkedAt: now - DAY_MS - 1,
        installed: '0.2.33',
        latest: '0.3.0',
      })
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
    assert.equal(cache.installed, '0.2.33');
    assert.equal(cache.checkedAt, now);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('updating the plugin invalidates the cache and triggers a fresh check', async () => {
  const home = makeDir('pg-home-');
  const root = makePluginRoot('0.4.37');
  const now = 1_000_000_000_000;
  const calls = [];
  try {
    // Fresh cache recorded while 0.2.33 was installed; the user has since
    // updated the plugin to 0.4.37 — the stale entry must not be trusted.
    mkdirSync(join(home, '.polygraph', 'logs'), { recursive: true });
    writeFileSync(
      cacheFile(home, 'claude'),
      JSON.stringify({ checkedAt: now - 60_000, installed: '0.2.33', latest: '0.4.37' })
    );

    const message = await checkPluginVersion({
      harness: 'claude',
      pluginRoot: root,
      home,
      fetchImpl: makeFetch('0.4.37', calls),
      now,
    });
    assert.equal(calls.length, 1, 'installed-version change forces a re-fetch');
    assert.equal(message, null);

    const cache = JSON.parse(readFileSync(cacheFile(home, 'claude'), 'utf8'));
    assert.equal(cache.installed, '0.4.37');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt or mismatched cache entries are not fresh', () => {
  const home = makeDir('pg-home-');
  const now = 1_000_000_000_000;
  try {
    mkdirSync(join(home, '.polygraph', 'logs'), { recursive: true });
    writeFileSync(cacheFile(home, 'claude'), 'not json');
    assert.equal(readCache('claude', home), null);

    assert.equal(isCacheFresh(null, '0.4.37', now), false);
    assert.equal(isCacheFresh({}, '0.4.37', now), false);
    assert.equal(
      isCacheFresh({ checkedAt: 'yesterday', installed: '0.4.37', latest: '0.4.37' }, '0.4.37', now),
      false
    );
    assert.equal(
      isCacheFresh({ checkedAt: now + 60_000, installed: '0.4.37', latest: '0.4.37' }, '0.4.37', now),
      false,
      'cache from the future is not trusted'
    );
    assert.equal(
      isCacheFresh({ checkedAt: now, installed: '0.4.37', latest: 'garbage' }, '0.4.37', now),
      false
    );
    assert.equal(
      isCacheFresh({ checkedAt: now, installed: '0.2.33', latest: '0.4.37' }, '0.4.37', now),
      false,
      'installed version mismatch is not fresh'
    );
    assert.equal(
      isCacheFresh({ checkedAt: now, installed: '0.4.37', latest: null }, '0.4.37', now),
      true,
      'recent negative cache is fresh'
    );
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

test('e2e: unreachable registry prints nothing, exits 0, logs and negative-caches', async () => {
  const home = makeDir('pg-home-');
  const { root, hookPath } = makeInstalledPlugin('0.2.33');
  try {
    const { stdout, stderr } = await runHook(hookPath, home, 'http://127.0.0.1:1');
    assert.equal(stdout, '');
    assert.equal(stderr, '');

    const logFile = join(home, '.polygraph', 'logs', 'hooks.log');
    const entries = readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(entries.length, 1);
    assert.equal(JSON.parse(entries[0]).hook, 'claude:check-plugin-version');

    // Second start within the cache window: the negative cache must prevent
    // another fetch attempt (no new failure log entry, still silent).
    const second = await runHook(hookPath, home, 'http://127.0.0.1:1');
    assert.equal(second.stdout, '');
    assert.equal(second.stderr, '');
    assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
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
    assert.equal(cache.installed, '0.4.37');
    assert.equal(cache.checkedAt, now);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
