import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PolygraphPlugin } from '../source/opencode/server.js';
import * as serverModule from '../source/opencode/server.js';
import {
  createOpenCodeSessionLinker,
  resolveOpenCodeRootSessionId,
} from '../source/opencode/agent-session-link.mjs';

async function withoutPolygraphEnv(fn) {
  const savedSession = process.env.POLYGRAPH_SESSION_ID;
  const savedChild = process.env.POLYGRAPH_CHILD_AGENT;
  delete process.env.POLYGRAPH_SESSION_ID;
  delete process.env.POLYGRAPH_CHILD_AGENT;
  try {
    return await fn();
  } finally {
    if (savedSession === undefined) delete process.env.POLYGRAPH_SESSION_ID;
    else process.env.POLYGRAPH_SESSION_ID = savedSession;
    if (savedChild === undefined) delete process.env.POLYGRAPH_CHILD_AGENT;
    else process.env.POLYGRAPH_CHILD_AGENT = savedChild;
  }
}

async function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pg-opencode-home-'));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await withoutPolygraphEnv(() => fn(join(home, '.polygraph')));
  } finally {
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  }
}

function fakeClient(records) {
  const calls = [];
  return {
    calls,
    session: {
      async get(options) {
        const id = options.path.id;
        calls.push(id);
        return { data: records[id] };
      },
    },
  };
}

test('PolygraphPlugin exposes the supported OpenCode hooks', async () => {
  await withoutPolygraphEnv(async () => {
    const plugin = await PolygraphPlugin();
    assert.equal(typeof plugin.config, 'function');
    assert.equal(typeof plugin['shell.env'], 'function');
    assert.equal(typeof plugin['tool.execute.after'], 'function');
    assert.equal(typeof plugin['experimental.session.compacting'], 'function');
  });
});

test('shell.env publishes the OpenCode agent identity', async () => {
  await withoutPolygraphEnv(async () => {
    const plugin = await PolygraphPlugin();
    const output = { env: { SOME_OTHER_VAR: 'preserved' } };
    await plugin['shell.env']({ sessionID: 'test-session-123' }, output);
    assert.deepEqual(output.env, {
      SOME_OTHER_VAR: 'preserved',
      POLYGRAPH_AGENT_SESSION_ID: 'test-session-123',
      POLYGRAPH_AGENT_TYPE: 'opencode',
    });
  });
});

test('config hook registers the skills path', async () => {
  const plugin = await PolygraphPlugin();
  const cfg = {};
  await plugin.config(cfg);
  assert.ok(Array.isArray(cfg.skills.paths));
  assert.equal(cfg.skills.paths.length, 1);
});

test('every server export remains a valid plugin factory', async () => {
  for (const [name, value] of Object.entries(serverModule)) {
    assert.equal(typeof value, 'function', `export "${name}" must be a function`);
    const hooks = await value({});
    assert.ok(
      hooks && typeof hooks === 'object',
      `export "${name}" must return a hooks object`
    );
  }
});

test('resolves an OpenCode subagent session to its exact root session', async () => {
  const client = fakeClient({
    child: { id: 'child', parentID: 'middle' },
    middle: { id: 'middle', parentID: 'root' },
    root: { id: 'root' },
  });

  assert.equal(await resolveOpenCodeRootSessionId(client, 'child'), 'root');
  assert.deepEqual(client.calls, ['child', 'middle', 'root']);
});

test('rejects cyclic or unavailable OpenCode session ancestry', async () => {
  const cyclic = fakeClient({
    child: { id: 'child', parentID: 'root' },
    root: { id: 'root', parentID: 'child' },
  });
  await assert.rejects(
    resolveOpenCodeRootSessionId(cyclic, 'child'),
    /parent cycle/
  );
  await assert.rejects(
    resolveOpenCodeRootSessionId(undefined, 'child'),
    /client\.session\.get is unavailable/
  );
  await assert.rejects(
    resolveOpenCodeRootSessionId(fakeClient({}), 'missing'),
    /was not found/
  );
});

test('environment binding links the exact root OpenCode session', async () => {
  const client = fakeClient({
    child: { id: 'child', parentID: 'root' },
    root: { id: 'root' },
  });
  const claims = [];
  const linker = createOpenCodeSessionLinker({
    client,
    directory: '/workspace/default',
    env: { POLYGRAPH_SESSION_ID: 'poly-session' },
    pid: 7654,
    link(claim) {
      claims.push(claim);
      return true;
    },
  });

  assert.equal(await linker.fromEnvironment('child', '/workspace/repo'), true);
  assert.deepEqual(claims, [
    {
      polygraphSessionId: 'poly-session',
      agentType: 'opencode',
      agentSessionId: 'root',
      cwd: '/workspace/repo',
      pid: 7654,
      source: 'hook',
    },
  ]);
});

test('OpenCode tool activity forwards only the exact root session identity', async () => {
  const client = fakeClient({
    child: { id: 'child', parentID: 'root' },
    root: { id: 'root' },
  });
  const claims = [];
  const linker = createOpenCodeSessionLinker({
    client,
    directory: '/workspace/repo',
    env: {},
    link(claim) {
      claims.push(claim);
      return true;
    },
  });

  await linker.fromToolActivity({
    tool: 'polygraph-mcp_start_session',
    sessionID: 'child',
    args: { sessionId: 'must-not-forward' },
    result: { sessionId: 'must-not-parse' },
  });

  assert.deepEqual(claims, [
    {
      agentType: 'opencode',
      agentSessionId: 'root',
      cwd: '/workspace/repo',
      pid: process.pid,
      source: 'hook',
    },
  ]);
});

test('OpenCode tool activity strips ambient session and capture-token evidence', async () => {
  const client = fakeClient({
    child: { id: 'child', parentID: 'root' },
    root: { id: 'root' },
  });
  const invocations = [];
  const env = {
    POLYGRAPH_SESSION_ID: 'ambient-poly-session',
    POLYGRAPH_CAPTURE_TOKEN: 'ambient-capture-token',
    REQUIRED_HARNESS_ENV: 'preserved',
  };
  const linker = createOpenCodeSessionLinker({
    client,
    directory: '/workspace/repo',
    env,
    pid: 2468,
    spawn(command, args, options) {
      invocations.push({ command, args, options });
      return { status: 0, stderr: '' };
    },
  });

  await linker.fromToolActivity({
    tool: 'polygraph-mcp_update_session',
    sessionID: 'child',
    args: { sessionId: 'input-poly-session', title: 'Title' },
  });

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, 'polygraph');
  assert.equal(invocations[0].args.includes('--session'), false);
  assert.ok(invocations[0].args.includes('root'));
  assert.equal(
    Object.hasOwn(invocations[0].options.env, 'POLYGRAPH_SESSION_ID'),
    false
  );
  assert.equal(
    Object.hasOwn(invocations[0].options.env, 'POLYGRAPH_CAPTURE_TOKEN'),
    false
  );
  assert.equal(invocations[0].options.env.REQUIRED_HARNESS_ENV, 'preserved');
});

test('OpenCode lifecycle links preserve session and capture-token evidence', async () => {
  const client = fakeClient({
    child: { id: 'child', parentID: 'root' },
    root: { id: 'root' },
  });
  let invocation;
  const env = {
    POLYGRAPH_SESSION_ID: 'lifecycle-poly-session',
    POLYGRAPH_CAPTURE_TOKEN: 'lifecycle-capture-token',
    REQUIRED_HARNESS_ENV: 'preserved',
  };
  const linker = createOpenCodeSessionLinker({
    client,
    directory: '/workspace/repo',
    env,
    pid: 2468,
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(await linker.fromEnvironment('child', '/workspace/exact'), true);
  assert.equal(invocation.command, 'polygraph');
  assert.ok(invocation.args.includes('lifecycle-poly-session'));
  assert.ok(invocation.args.includes('root'));
  assert.ok(invocation.args.includes('/workspace/exact'));
  assert.equal(invocation.options.env, env);
  assert.equal(
    invocation.options.env.POLYGRAPH_SESSION_ID,
    'lifecycle-poly-session'
  );
  assert.equal(
    invocation.options.env.POLYGRAPH_CAPTURE_TOKEN,
    'lifecycle-capture-token'
  );
});

test('OpenCode read and failed tool activity still submits evidence', async () => {
  const claims = [];
  const client = fakeClient({ root: { id: 'root' } });
  const linker = createOpenCodeSessionLinker({
    client,
    env: {},
    link(claim) {
      claims.push(claim);
      return true;
    },
  });

  assert.equal(
    await linker.fromToolActivity({
      tool: 'polygraph-mcp_show_session',
      sessionID: 'root',
      args: { sessionId: 'poly-session' },
      error: { message: 'tool failed' },
    }),
    true
  );
  assert.deepEqual(client.calls, ['root']);
  assert.equal(claims.length, 1);
  assert.equal(Object.hasOwn(claims[0], 'polygraphSessionId'), false);
});

test('OpenCode ignores non-Polygraph tool activity', async () => {
  const claims = [];
  const client = fakeClient({ root: { id: 'root' } });
  const linker = createOpenCodeSessionLinker({
    client,
    env: {},
    link(claim) {
      claims.push(claim);
      return true;
    },
  });

  assert.equal(
    await linker.fromToolActivity({
      tool: 'other-mcp_start_session',
      sessionID: 'root',
    }),
    false
  );
  assert.deepEqual(client.calls, []);
  assert.deepEqual(claims, []);
});

test('OpenCode managed-child lifecycle and tool paths never invoke links', async () => {
  let spawnCount = 0;
  const client = fakeClient({ child: { id: 'child' } });
  const linker = createOpenCodeSessionLinker({
    client,
    env: {
      POLYGRAPH_SESSION_ID: 'poly-session',
      POLYGRAPH_CHILD_AGENT: '',
    },
    spawn() {
      spawnCount += 1;
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(await linker.fromEnvironment('child'), false);
  assert.equal(
    await linker.fromToolActivity({
      tool: 'polygraph-mcp_update_session',
      sessionID: 'child',
      args: { sessionId: 'poly-session' },
    }),
    false
  );
  assert.deepEqual(client.calls, []);
  assert.equal(spawnCount, 0);
});

function seedPolygraphSession(root, agentSessionId, polygraphSessionId, location) {
  const sidecarDir =
    location === 'legacy'
      ? join(root, 'sidecars', polygraphSessionId)
      : join(root, 'sessions', polygraphSessionId, 'sidecars');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, `parent-${agentSessionId}.json`),
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
}

for (const location of ['new', 'legacy']) {
  test(`compacting hook preserves Polygraph context (${location} sidecar)`, async () => {
    await withTempHome(async (root) => {
      const agentSessionId = 'ses_opencode_demo';
      seedPolygraphSession(root, agentSessionId, 'demo-session-abc', location);

      const plugin = await PolygraphPlugin();
      const output = { context: [] };
      await plugin['experimental.session.compacting'](
        { sessionID: agentSessionId },
        output
      );

      assert.equal(output.context.length, 1);
      assert.match(output.context[0], /Polygraph session demo-session-abc/);
      assert.match(output.context[0], /nrwl\/polygraph-skills, nrwl\/ocean/);
      assert.match(output.context[0], /[Pp]reserve/);
    });
  });
}

test('compacting hook is a no-op outside a Polygraph session', async () => {
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
