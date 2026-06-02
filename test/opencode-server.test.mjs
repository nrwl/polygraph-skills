import test from 'node:test';
import assert from 'node:assert/strict';

import { PolygraphPlugin } from '../source/opencode/server.js';

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
