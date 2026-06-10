import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolygraphPlugin } from '../source/opencode/server.js';
import * as serverModule from '../source/opencode/server.js';

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
