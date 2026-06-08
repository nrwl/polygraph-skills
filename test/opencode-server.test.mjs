import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PolygraphPlugin,
  polygraphCompactionNote,
} from '../source/opencode/server.js';

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

test('polygraphCompactionNote builds a preserve note from local Polygraph state', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-opencode-'));
  try {
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

    const note = polygraphCompactionNote(agentSessionId, root);
    assert.match(note, /Polygraph session demo-session-abc/);
    assert.match(note, /nrwl\/polygraph-skills, nrwl\/ocean/);
    assert.match(note, /[Pp]reserve/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('polygraphCompactionNote returns undefined outside a Polygraph session', () => {
  const root = mkdtempSync(join(tmpdir(), 'pg-opencode-empty-'));
  try {
    assert.equal(polygraphCompactionNote('ses_unknown', root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
