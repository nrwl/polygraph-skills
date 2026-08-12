import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as linkModule from '../source/hooks/agent-session-link.mjs';
import {
  buildCommandHookLink,
  buildLinkAgentSessionArgs,
  isPolygraphMcpToolName,
  linkAgentSession,
} from '../source/hooks/agent-session-link.mjs';
import { main } from '../source/hooks/record-session-mapping.mjs';

test('Claude and Codex register broad Polygraph PostToolUse hooks', () => {
  for (const relativePath of [
    '../source/hooks/hooks.json',
    '../source/codex/hooks/hooks.json',
  ]) {
    const manifest = JSON.parse(
      readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    );
    const hooks = manifest.hooks.PostToolUse;
    assert.equal(hooks.length, 1);

    const matcher = new RegExp(hooks[0].matcher);
    assert.equal(matcher.test('mcp__polygraph-mcp__show_session'), true);
    assert.equal(matcher.test('mcp__polygraph_mcp__unknown_future_tool'), true);
    assert.equal(
      matcher.test('mcp__plugin_polygraph_polygraph-mcp__start_session'),
      true
    );
    assert.equal(matcher.test('mcp__some-other-server__start_session'), false);
    assert.doesNotMatch(hooks[0].matcher, /start_session|update_session|show_session/);
    assert.match(hooks[0].hooks[0].command, /record-session-mapping\.mjs/);
  }
});

test('recognizes Polygraph MCP activity by server prefix only', () => {
  for (const toolName of [
    'mcp__polygraph-mcp__show_session',
    'mcp__polygraph_mcp__unknown_future_tool',
    'mcp__plugin_polygraph_polygraph-mcp__failed_tool',
    'mcp__plugin_polygraph_polygraph_mcp__anything',
    'polygraph-mcp_show_session',
    'polygraph_mcp_failed_tool',
    'polygraph_unknown_future_tool',
  ]) {
    assert.equal(isPolygraphMcpToolName(toolName), true, toolName);
  }

  for (const toolName of [
    'mcp__some-other-server__start_session',
    'other-mcp_show_session',
    'polygraphical_tool',
    '',
  ]) {
    assert.equal(isPolygraphMcpToolName(toolName), false, toolName);
  }
});

test('the hook helper exposes no operation-specific parsing API', () => {
  assert.deepEqual(Object.keys(linkModule).sort(), [
    'buildCommandHookLink',
    'buildLinkAgentSessionArgs',
    'isPolygraphMcpToolName',
    'linkAgentSession',
    'logHookFailure',
  ]);

  const source = readFileSync(
    new URL('../source/hooks/agent-session-link.mjs', import.meta.url),
    'utf8'
  );
  for (const forbidden of [
    'SESSION_MUTATION_TOOLS',
    'derivePolygraphSessionClaim',
    'extractStartedSessionId',
    'parsePolygraphMutationTool',
    'tool_input',
    'tool_response',
    '--set-resume-target',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('builds a lifecycle link with exact session and capture metadata', () => {
  assert.deepEqual(
    buildLinkAgentSessionArgs({
      polygraphSessionId: 'poly/session?exact=true',
      agentType: 'codex',
      agentSessionId: 'codex/thread/root',
      cwd: '/workspace/repo with spaces',
      transcriptPath: '/tmp/rollout exact.jsonl',
      pid: 1234,
      source: 'hook',
    }),
    [
      '_link-agent-session',
      '--session',
      'poly/session?exact=true',
      '--agent-type',
      'codex',
      '--agent-session-id',
      'codex/thread/root',
      '--cwd',
      '/workspace/repo with spaces',
      '--transcript-path',
      '/tmp/rollout exact.jsonl',
      '--pid',
      '1234',
      '--source',
      'hook',
    ]
  );
});

test('builds a PostTool link without a Polygraph session or operation flags', () => {
  assert.deepEqual(
    buildLinkAgentSessionArgs({
      agentType: 'opencode',
      agentSessionId: 'oc-root',
      source: 'hook',
      setResumeTarget: true,
      operation: 'start_session',
    }),
    [
      '_link-agent-session',
      '--agent-type',
      'opencode',
      '--agent-session-id',
      'oc-root',
      '--source',
      'hook',
    ]
  );
});

test('uses the configured Polygraph CLI executable', () => {
  let invocation;
  const env = { POLYGRAPH_CLI: '/workspace/dist/bin/polygraph.js' };
  assert.equal(
    linkAgentSession(
      {
        agentType: 'codex',
        agentSessionId: 'codex-root',
        source: 'hook',
      },
      (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stderr: '' };
      },
      env
    ),
    true
  );
  assert.equal(invocation.command, '/workspace/dist/bin/polygraph.js');
  assert.equal(invocation.options.env.POLYGRAPH_CLI, env.POLYGRAPH_CLI);
});

test('identity-only links strip ambient session and capture-token evidence', () => {
  let invocation;
  const env = {
    POLYGRAPH_CAPTURE_TOKEN: 'opaque-launch-evidence',
    POLYGRAPH_SESSION_ID: 'environment-session',
    REQUIRED_HARNESS_ENV: 'preserved',
  };
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0, stderr: '' };
  };

  assert.equal(
    linkAgentSession(
      {
        agentType: 'claude',
        agentSessionId: 'claude-session',
        source: 'hook',
      },
      spawn,
      env
    ),
    true
  );
  assert.equal(invocation.command, 'polygraph');
  assert.equal(invocation.args[0], '_link-agent-session');
  assert.equal(invocation.args.includes('--session'), false);
  assert.equal(invocation.args.includes('--set-resume-target'), false);
  assert.notEqual(invocation.options.env, env);
  assert.equal(
    Object.hasOwn(invocation.options.env, 'POLYGRAPH_SESSION_ID'),
    false
  );
  assert.equal(
    Object.hasOwn(invocation.options.env, 'POLYGRAPH_CAPTURE_TOKEN'),
    false
  );
  assert.equal(invocation.options.env.REQUIRED_HARNESS_ENV, 'preserved');
  assert.equal(Object.hasOwn(invocation.options, 'shell'), false);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'pipe']);
});

test('managed-child environments never invoke the shared link command', () => {
  let spawnCount = 0;
  const spawn = () => {
    spawnCount += 1;
    return { status: 0, stderr: '' };
  };
  const env = { POLYGRAPH_CHILD_AGENT: '' };

  for (const claim of [
    {
      polygraphSessionId: 'poly-session',
      agentType: 'claude',
      agentSessionId: 'claude-session',
      source: 'hook',
    },
    {
      agentType: 'codex',
      agentSessionId: 'codex-session',
      source: 'hook',
    },
  ]) {
    assert.equal(linkAgentSession(claim, spawn, env), false);
  }

  assert.equal(spawnCount, 0);
});

test('reports hidden CLI command failures to the hook wrapper', () => {
  assert.throws(
    () =>
      linkAgentSession(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          source: 'hook',
        },
        () => ({ status: 2, stderr: 'invalid evidence' }),
        {}
      ),
    /status 2: invalid evidence/
  );
});

test('SessionStart forwards exact lifecycle identity and metadata', () => {
  assert.deepEqual(
    buildCommandHookLink(
      {
        hook_event_name: 'SessionStart',
        session_id: 'claude/root-session',
        cwd: '/workspace/exact repo',
        transcript_path: '/tmp/exact transcript.jsonl',
      },
      'claude',
      { POLYGRAPH_SESSION_ID: 'poly/exact-session' }
    ),
    {
      polygraphSessionId: 'poly/exact-session',
      agentType: 'claude',
      agentSessionId: 'claude/root-session',
      cwd: '/workspace/exact repo',
      transcriptPath: '/tmp/exact transcript.jsonl',
      source: 'hook',
    }
  );
});

test('SessionStart requires launch-provided POLYGRAPH_SESSION_ID', () => {
  assert.equal(
    buildCommandHookLink(
      { hook_event_name: 'SessionStart', session_id: 'claude-session' },
      'claude',
      {}
    ),
    undefined
  );
});

test('PostToolUse ignores tool inputs, results, and ambient Polygraph session IDs', () => {
  const payload = {
    hook_event_name: 'PostToolUse',
    session_id: 'codex/exact-thread',
    cwd: '/workspace/repo',
    transcript_path: '/tmp/rollout.jsonl',
    tool_name: 'mcp__polygraph-mcp__show_session',
    tool_input: { sessionId: 'must-not-forward' },
    tool_response: {
      isError: true,
      structuredContent: { sessionId: 'must-not-parse' },
    },
  };

  assert.deepEqual(
    buildCommandHookLink(payload, 'codex', {
      POLYGRAPH_SESSION_ID: 'must-not-bind-post-tool',
    }),
    {
      agentType: 'codex',
      agentSessionId: 'codex/exact-thread',
      cwd: '/workspace/repo',
      transcriptPath: '/tmp/rollout.jsonl',
      source: 'hook',
    }
  );

  assert.deepEqual(
    buildCommandHookLink(
      {
        ...payload,
        tool_name: 'mcp__polygraph-mcp__start_session',
        tool_response: { sessionId: 'also-must-not-parse' },
      },
      'codex',
      {}
    ),
    buildCommandHookLink(payload, 'codex', {})
  );
});

test('only exact lifecycle and PostToolUse event IDs are accepted', () => {
  const common = {
    session_id: 'parent-session',
    tool_name: 'mcp__polygraph-mcp__anything',
  };
  assert.equal(
    buildCommandHookLink({ ...common, hook_event_name: 'posttooluse' }, 'claude', {}),
    undefined
  );
  assert.equal(
    buildCommandHookLink({ ...common, hook_event_name: 'PostToolUseFailure' }, 'claude', {}),
    undefined
  );
  assert.equal(
    buildCommandHookLink(
      { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__other__anything' },
      'claude',
      {}
    ),
    undefined
  );
});

test('Claude and Codex managed-child lifecycle and PostTool hooks never invoke links', () => {
  for (const [agentType, agentSessionId] of [
    ['claude', 'claude/child'],
    ['codex', 'codex/child'],
  ]) {
    for (const payload of [
      {
        hook_event_name: 'SessionStart',
        session_id: agentSessionId,
      },
      {
        hook_event_name: 'PostToolUse',
        session_id: agentSessionId,
        tool_name: 'mcp__polygraph-mcp__anything',
      },
    ]) {
      let spawnCount = 0;
      const result = main({
        agentType,
        env: {
          POLYGRAPH_CHILD_AGENT: '',
          POLYGRAPH_SESSION_ID: 'poly-session',
        },
        payload,
        spawn() {
          spawnCount += 1;
          return { status: 0, stderr: '' };
        },
      });

      assert.equal(result, false);
      assert.equal(spawnCount, 0);
    }
  }
});

test('Claude and Codex lifecycle hooks preserve session and capture-token evidence', () => {
  for (const [agentType, agentSessionId] of [
    ['claude', 'claude/root'],
    ['codex', 'codex/root'],
  ]) {
    let invocation;
    const env = {
      POLYGRAPH_SESSION_ID: 'poly-session',
      POLYGRAPH_CAPTURE_TOKEN: 'opaque-token',
    };
    const result = main({
      agentType,
      env,
      pid: 4321,
      payload: {
        hook_event_name: 'SessionStart',
        session_id: agentSessionId,
        cwd: '/workspace/repo',
        transcript_path: '/tmp/transcript.jsonl',
      },
      spawn(command, args, options) {
        invocation = { command, args, options };
        return { status: 0, stderr: '' };
      },
    });

    assert.equal(result, true);
    assert.equal(invocation.command, 'polygraph');
    assert.deepEqual(invocation.args.slice(0, 3), [
      '_link-agent-session',
      '--session',
      'poly-session',
    ]);
    assert.ok(invocation.args.includes(agentType));
    assert.ok(invocation.args.includes(agentSessionId));
    assert.ok(invocation.args.includes('/tmp/transcript.jsonl'));
    assert.equal(invocation.options.env, env);
    assert.equal(invocation.options.env.POLYGRAPH_SESSION_ID, 'poly-session');
    assert.equal(invocation.options.env.POLYGRAPH_CAPTURE_TOKEN, 'opaque-token');
  }
});

test('read and failed PostToolUse activity forwards identity without session semantics', () => {
  for (const toolResponse of [
    { content: [{ type: 'text', text: 'Session details' }] },
    { isError: true, content: [{ type: 'text', text: 'Failed' }] },
  ]) {
    let invocation;
    const env = {
      POLYGRAPH_SESSION_ID: 'ambient-session',
      POLYGRAPH_CAPTURE_TOKEN: 'opaque-token',
      REQUIRED_HARNESS_ENV: 'preserved',
    };
    const result = main({
      agentType: 'codex',
      env,
      pid: 9876,
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'codex/root-thread',
        tool_name: 'mcp__polygraph-mcp__show_session',
        tool_input: { sessionId: 'input-session' },
        tool_response: toolResponse,
      },
      spawn(command, args, options) {
        invocation = { command, args, options };
        return { status: 0, stderr: '' };
      },
    });

    assert.equal(result, true);
    assert.equal(invocation.args[0], '_link-agent-session');
    assert.equal(invocation.args.includes('--session'), false);
    assert.equal(invocation.args.includes('ambient-session'), false);
    assert.equal(invocation.args.includes('input-session'), false);
    assert.equal(invocation.args.includes('--set-resume-target'), false);
    assert.ok(invocation.args.includes('codex/root-thread'));
    assert.equal(
      Object.hasOwn(invocation.options.env, 'POLYGRAPH_SESSION_ID'),
      false
    );
    assert.equal(
      Object.hasOwn(invocation.options.env, 'POLYGRAPH_CAPTURE_TOKEN'),
      false
    );
    assert.equal(invocation.options.env.REQUIRED_HARNESS_ENV, 'preserved');
  }
});
