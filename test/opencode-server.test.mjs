import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolygraphPlugin } from '../source/opencode/server.js';
import * as serverModule from '../source/opencode/server.js';
import { writeAgentCaptureMapping } from '../source/opencode/agent-capture-mapping.mjs';

// The compaction-note helpers resolve Polygraph state under os.homedir(), so
// these tests point HOME at a temp dir instead of injecting a root.
async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pg-opencode-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(join(home, '.polygraph'));
  } finally {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test('PolygraphPlugin returns a shell.env hook', async () => {
  const plugin = await PolygraphPlugin();
  assert.equal(typeof plugin['shell.env'], 'function');
});

test('shell.env sets POLYGRAPH_AGENT_SESSION_ID from input.sessionID', async () => {
  const plugin = await PolygraphPlugin();
  const output = { env: {} };
  await plugin['shell.env']({ sessionID: 'test-session-123' }, output);
  assert.equal(output.env.POLYGRAPH_AGENT_SESSION_ID, 'test-session-123');
});

test('shell.env sets POLYGRAPH_AGENT_TYPE to "opencode"', async () => {
  const plugin = await PolygraphPlugin();
  const output = { env: {} };
  await plugin['shell.env']({ sessionID: 'any-session' }, output);
  assert.equal(output.env.POLYGRAPH_AGENT_TYPE, 'opencode');
});

test('shell.env does not overwrite unrelated env vars', async () => {
  const plugin = await PolygraphPlugin();
  const output = { env: { SOME_OTHER_VAR: 'preserved' } };
  await plugin['shell.env']({ sessionID: 'sess-abc' }, output);
  assert.equal(output.env.SOME_OTHER_VAR, 'preserved');
  assert.equal(output.env.POLYGRAPH_AGENT_SESSION_ID, 'sess-abc');
  assert.equal(output.env.POLYGRAPH_AGENT_TYPE, 'opencode');
});

test('PolygraphPlugin still returns a config hook', async () => {
  const plugin = await PolygraphPlugin();
  assert.equal(typeof plugin.config, 'function');
});

test('config hook still registers skills path', async () => {
  const plugin = await PolygraphPlugin();
  const cfg = {};
  await plugin.config(cfg);
  assert.ok(Array.isArray(cfg.skills.paths));
  assert.equal(cfg.skills.paths.length, 1);
});

test('PolygraphPlugin exposes the experimental.session.compacting hook', async () => {
  const plugin = await PolygraphPlugin();
  assert.equal(typeof plugin['experimental.session.compacting'], 'function');
});

test('compacting hook pushes a preserve note built from local Polygraph state', async () => {
  await withTempHome(async (root) => {
    const agentSessionId = 'ses_opencode_demo';
    const polygraphSessionId = 'demo-session-abc';
    mkdirSync(join(root, 'sidecars', polygraphSessionId), { recursive: true });
    writeFileSync(
      join(root, 'sidecars', polygraphSessionId, `parent-${agentSessionId}.json`),
      JSON.stringify({
        sessionId: polygraphSessionId,
        parentSessionId: agentSessionId,
        parentAgentType: 'opencode',
      })
    );
    mkdirSync(join(root, 'sessions', polygraphSessionId, 'session'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'sessions', polygraphSessionId, 'session', 'session.json'),
      JSON.stringify({
        sessionId: polygraphSessionId,
        repos: [
          { repoFullName: 'nrwl/polygraph-skills' },
          { repoFullName: 'nrwl/ocean' },
        ],
      })
    );

    const plugin = await PolygraphPlugin();
    const output = { context: [] };
    await plugin['experimental.session.compacting'](
      { sessionID: agentSessionId },
      output
    );

    assert.equal(output.context.length, 1);
    const note = output.context[0];
    assert.match(note, /Polygraph session demo-session-abc/);
    assert.match(note, /nrwl\/polygraph-skills, nrwl\/ocean/);
    assert.match(note, /[Pp]reserve/);
  });
});

test('compacting hook pushes nothing outside a Polygraph session', async () => {
  await withTempHome(async () => {
    const plugin = await PolygraphPlugin();
    const output = { context: [] };
    await plugin['experimental.session.compacting'](
      { sessionID: 'ses_unknown' },
      output
    );
    assert.deepEqual(output.context, []);
  });
});

// OpenCode's plugin loader calls EVERY export of this module as a plugin
// factory and registers whatever it returns as a hooks object. An export that
// is not a function — or whose result is not a hooks object — crashes the
// OpenCode server on startup ("Unexpected server error").
test('every export is a plugin factory that returns a hooks object', async () => {
  for (const [name, value] of Object.entries(serverModule)) {
    assert.equal(typeof value, 'function', `export "${name}" must be a function`);
    const hooks = await value({});
    assert.ok(
      hooks && typeof hooks === 'object',
      `export "${name}" must return a hooks object when called as a plugin factory`
    );
  }
});

test('experimental.session.compacting is a no-op outside a Polygraph session', async () => {
  const plugin = await PolygraphPlugin();
  const output = { context: [] };
  await plugin['experimental.session.compacting'](
    { sessionID: 'ses_definitely_not_a_polygraph_session' },
    output
  );
  assert.deepEqual(output.context, []);
});

// ---------------------------------------------------------------------------
// writeAgentCaptureMapping tests
// ---------------------------------------------------------------------------

function savePgEnv() {
  return {
    POLYGRAPH_SESSION_ID: process.env.POLYGRAPH_SESSION_ID,
    POLYGRAPH_CHILD_AGENT: process.env.POLYGRAPH_CHILD_AGENT,
  };
}

function restorePgEnv(saved) {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function readMappingFiles(home, polygraphSessionId) {
  const dir = join(home, '.polygraph', 'sidecars', polygraphSessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('mapping-'));
}

function readMappingJson(home, polygraphSessionId) {
  const files = readMappingFiles(home, polygraphSessionId);
  assert.equal(files.length, 1);
  return JSON.parse(
    readFileSync(
      join(home, '.polygraph', 'sidecars', polygraphSessionId, files[0]),
      'utf8'
    )
  );
}

test('writeAgentCaptureMapping writes a valid opencode mapping file', () => {
  const saved = savePgEnv();
  const home = mkdtempSync(join(tmpdir(), 'pg-oc-map-'));
  try {
    process.env.POLYGRAPH_SESSION_ID = 'poly-oc-1';
    delete process.env.POLYGRAPH_CHILD_AGENT;

    const before = Date.now();
    writeAgentCaptureMapping('ses_oc_abc', home);
    const after = Date.now();

    const mapping = readMappingJson(home, 'poly-oc-1');

    assert.equal(mapping.version, 1);
    assert.equal(mapping.polygraphSessionId, 'poly-oc-1');
    assert.equal(mapping.agentType, 'opencode');
    assert.equal(mapping.agentSessionId, 'ses_oc_abc');
    assert.equal(mapping.source, 'hook');
    assert.equal(typeof mapping.cwd, 'string');
    assert.ok(mapping.cwd.length > 0);
    assert.ok(Number.isFinite(mapping.pid));
    assert.ok(Number.isFinite(mapping.firstSeenAt));
    assert.ok(Number.isFinite(mapping.lastSeenAt));
    assert.ok(mapping.firstSeenAt >= before && mapping.firstSeenAt <= after);
    assert.equal(Object.hasOwn(mapping, 'transcriptPath'), false);
  } finally {
    restorePgEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeAgentCaptureMapping is a no-op when POLYGRAPH_SESSION_ID is unset', () => {
  const saved = savePgEnv();
  const home = mkdtempSync(join(tmpdir(), 'pg-oc-noop-'));
  try {
    delete process.env.POLYGRAPH_SESSION_ID;
    delete process.env.POLYGRAPH_CHILD_AGENT;

    writeAgentCaptureMapping('ses_oc_noop', home);

    assert.equal(
      existsSync(join(home, '.polygraph')),
      false,
      'no file written when POLYGRAPH_SESSION_ID unset'
    );
  } finally {
    restorePgEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeAgentCaptureMapping is a no-op when POLYGRAPH_CHILD_AGENT is set', () => {
  const saved = savePgEnv();
  const home = mkdtempSync(join(tmpdir(), 'pg-oc-child-'));
  try {
    process.env.POLYGRAPH_SESSION_ID = 'poly-oc-child';
    process.env.POLYGRAPH_CHILD_AGENT = '1';

    writeAgentCaptureMapping('ses_oc_child', home);

    assert.equal(readMappingFiles(home, 'poly-oc-child').length, 0);
  } finally {
    restorePgEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeAgentCaptureMapping is a no-op when agentSessionId is empty', () => {
  const saved = savePgEnv();
  const home = mkdtempSync(join(tmpdir(), 'pg-oc-empty-'));
  try {
    process.env.POLYGRAPH_SESSION_ID = 'poly-oc-empty';
    delete process.env.POLYGRAPH_CHILD_AGENT;

    writeAgentCaptureMapping('', home);

    assert.equal(readMappingFiles(home, 'poly-oc-empty').length, 0);
  } finally {
    restorePgEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeAgentCaptureMapping preserves firstSeenAt and bumps lastSeenAt on refresh', () => {
  const saved = savePgEnv();
  const home = mkdtempSync(join(tmpdir(), 'pg-oc-refresh-'));
  try {
    process.env.POLYGRAPH_SESSION_ID = 'poly-oc-refresh';
    delete process.env.POLYGRAPH_CHILD_AGENT;

    writeAgentCaptureMapping('ses_oc_refresh', home);
    const first = readMappingJson(home, 'poly-oc-refresh');

    const end = Date.now() + 2;
    while (Date.now() < end) { /* busy-wait one tick */ }

    writeAgentCaptureMapping('ses_oc_refresh', home);
    const second = readMappingJson(home, 'poly-oc-refresh');

    assert.equal(second.firstSeenAt, first.firstSeenAt, 'firstSeenAt preserved');
    assert.ok(second.lastSeenAt >= first.lastSeenAt, 'lastSeenAt updated');
  } finally {
    restorePgEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
});

test('shell.env writes a mapping file when POLYGRAPH_SESSION_ID is set', async () => {
  const saved = savePgEnv();
  const home = mkdtempSync(join(tmpdir(), 'pg-oc-shell-env-'));
  try {
    process.env.POLYGRAPH_SESSION_ID = 'poly-shell-env';
    delete process.env.POLYGRAPH_CHILD_AGENT;

    // Call writeAgentCaptureMapping via the plugin's shell.env hook by overriding
    // HOME so the in-process call lands in our temp dir.
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const plugin = await PolygraphPlugin();
      const output = { env: {} };
      await plugin['shell.env']({ sessionID: 'ses_shell_env_test' }, output);

      // shell.env must still set the env vars correctly
      assert.equal(output.env.POLYGRAPH_AGENT_SESSION_ID, 'ses_shell_env_test');
      assert.equal(output.env.POLYGRAPH_AGENT_TYPE, 'opencode');

      // and the mapping must be on disk
      const mapping = readMappingJson(home, 'poly-shell-env');
      assert.equal(mapping.agentType, 'opencode');
      assert.equal(mapping.agentSessionId, 'ses_shell_env_test');
    } finally {
      process.env.HOME = savedHome;
    }
  } finally {
    restorePgEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
});
