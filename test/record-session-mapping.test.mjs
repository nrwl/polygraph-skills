import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SESSION_MUTATION_TOOLS,
  buildCommandHookClaim,
  buildLinkAgentSessionArgs,
  derivePolygraphSessionClaim,
  extractStartedSessionId,
  linkAgentSession,
  parsePolygraphMutationTool,
} from '../source/hooks/agent-session-link.mjs';
import { main } from '../source/hooks/record-session-mapping.mjs';

const startResponse = {
  content: [
    {
      type: 'text',
      text: 'Session merry-swan-123 (/tmp/session)\nRepositories:\n- nrwl/ocean',
    },
  ],
  isError: false,
};

test('Claude and Codex register successful PostToolUse command hooks', () => {
  for (const relativePath of [
    '../source/hooks/hooks.json',
    '../source/codex/hooks/hooks.json',
  ]) {
    const manifest = JSON.parse(
      readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    );
    const hooks = manifest.hooks.PostToolUse;
    assert.equal(hooks.length, 1);
    assert.match(hooks[0].matcher, /start_session/);
    assert.match(hooks[0].matcher, /update_session/);
    assert.match(hooks[0].hooks[0].command, /record-session-mapping\.mjs/);
  }
});

test('recognizes Polygraph mutation names from Claude, Codex, and OpenCode', () => {
  assert.equal(
    parsePolygraphMutationTool(
      'mcp__plugin_polygraph_polygraph-mcp__start_session'
    ),
    'start_session'
  );
  assert.equal(
    parsePolygraphMutationTool('mcp__polygraph-mcp__update_session'),
    'update_session'
  );
  assert.equal(
    parsePolygraphMutationTool('polygraph-mcp_spawn_agent'),
    'spawn_agent'
  );
  assert.equal(
    parsePolygraphMutationTool('polygraph_mcp_archive_session'),
    'archive_session'
  );
  assert.equal(parsePolygraphMutationTool('polygraph_add_repo'), 'add_repo');
});

test('the supported mutation registry is fully parseable', () => {
  for (const operation of SESSION_MUTATION_TOOLS) {
    assert.equal(
      parsePolygraphMutationTool(`mcp__polygraph-mcp__${operation}`),
      operation
    );
  }
});

test('read operations and other MCP servers never produce mutations', () => {
  for (const operation of [
    'show_session',
    'show_agent',
    'list_sessions',
    'list_repos',
    'list_artifacts',
    'search_sessions',
    'get_ci_logs',
    'session_intro',
    'whoami',
  ]) {
    assert.equal(
      parsePolygraphMutationTool(`mcp__polygraph-mcp__${operation}`),
      undefined,
      operation
    );
  }
  assert.equal(
    parsePolygraphMutationTool('mcp__some-other-server__start_session'),
    undefined
  );
});

test('extracts a started session ID from the current MCP text result', () => {
  assert.equal(extractStartedSessionId(startResponse), 'merry-swan-123');
});

test('extracts a started session ID from structured and OpenCode output results', () => {
  assert.equal(
    extractStartedSessionId({
      structuredContent: { sessionId: 'structured-session' },
    }),
    'structured-session'
  );
  assert.equal(
    extractStartedSessionId({
      title: 'Started session',
      output: 'Session opencode-session\nRepositories:\n- nrwl/ocean',
      metadata: {},
    }),
    'opencode-session'
  );
  assert.equal(
    extractStartedSessionId({ content: [{ type: 'text', text: '{"sessionId":"json-session"}' }] }),
    'json-session'
  );
});

test('does not derive a start claim from an MCP error or unrecognized response', () => {
  assert.equal(
    derivePolygraphSessionClaim({
      toolName: 'mcp__polygraph-mcp__start_session',
      toolResponse: { ...startResponse, isError: true },
    }),
    undefined
  );
  assert.equal(
    derivePolygraphSessionClaim({
      toolName: 'mcp__polygraph-mcp__start_session',
      toolResponse: { content: [{ type: 'text', text: 'No session here' }] },
    }),
    undefined
  );
});

test('start_session derives the session ID from the successful result', () => {
  assert.deepEqual(
    derivePolygraphSessionClaim({
      toolName: 'mcp__polygraph-mcp__start_session',
      toolInput: { sessionId: 'must-not-win' },
      toolResponse: startResponse,
    }),
    {
      operation: 'start_session',
      polygraphSessionId: 'merry-swan-123',
      setResumeTarget: true,
    }
  );
});

test('other mutations derive the session ID from tool input', () => {
  assert.deepEqual(
    derivePolygraphSessionClaim({
      toolName: 'mcp__polygraph-mcp__add_repo',
      toolInput: { sessionId: 'session-from-input', repoIds: ['repo-1'] },
      toolResponse: { content: [{ type: 'text', text: 'Added repository' }] },
    }),
    { operation: 'add_repo', polygraphSessionId: 'session-from-input' }
  );
});

test('failed non-start mutations do not produce claims', () => {
  assert.equal(
    derivePolygraphSessionClaim({
      toolName: 'mcp__polygraph-mcp__update_session',
      toolInput: { sessionId: 'poly-session', title: 'Title' },
      toolResponse: { isError: true, content: [{ type: 'text', text: 'Failed' }] },
    }),
    undefined
  );
});

test('builds the creator CLI command with optional metadata and resume target flag', () => {
  assert.deepEqual(
    buildLinkAgentSessionArgs({
      polygraphSessionId: 'poly-session',
      agentType: 'codex',
      agentSessionId: 'codex-thread',
      cwd: '/workspace/repo',
      transcriptPath: '/tmp/rollout.jsonl',
      pid: 1234,
      setResumeTarget: true,
      source: 'hook',
    }),
    [
      '_link-agent-session',
      '--session',
      'poly-session',
      '--agent-type',
      'codex',
      '--agent-session-id',
      'codex-thread',
      '--cwd',
      '/workspace/repo',
      '--transcript-path',
      '/tmp/rollout.jsonl',
      '--pid',
      '1234',
      '--set-resume-target',
      '--source',
      'hook',
    ]
  );
});

test('omits unavailable optional CLI command arguments', () => {
  assert.deepEqual(
    buildLinkAgentSessionArgs({
      polygraphSessionId: 'poly-session',
      agentType: 'opencode',
      agentSessionId: 'oc-session',
      source: 'hook',
    }),
    [
      '_link-agent-session',
      '--session',
      'poly-session',
      '--agent-type',
      'opencode',
      '--agent-session-id',
      'oc-session',
      '--source',
      'hook',
    ]
  );
});

test('invokes polygraph directly without shell interpolation', () => {
  let invocation;
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0, stderr: '' };
  };

  assert.equal(
    linkAgentSession(
      {
        polygraphSessionId: 'session; touch /tmp/nope',
        agentType: 'claude',
        agentSessionId: 'claude-session',
        source: 'hook',
      },
      spawn
    ),
    true
  );
  assert.equal(invocation.command, 'polygraph');
  assert.equal(invocation.args[2], 'session; touch /tmp/nope');
  assert.equal(invocation.args.includes('--set-resume-target'), false);
  assert.equal(Object.hasOwn(invocation.options, 'shell'), false);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'pipe']);
});

test('reports hidden CLI command failures to the hook wrapper', () => {
  assert.throws(
    () =>
      linkAgentSession(
        {
          polygraphSessionId: 'poly-session',
          agentType: 'claude',
          agentSessionId: 'claude-session',
          source: 'hook',
        },
        () => ({ status: 2, stderr: 'invalid claim' })
      ),
    /status 2: invalid claim/
  );
});

test('SessionStart preserves POLYGRAPH_SESSION_ID binding', () => {
  const claim = buildCommandHookClaim(
    {
      hook_event_name: 'SessionStart',
      session_id: 'claude-session',
      cwd: '/workspace/repo',
      transcript_path: '/tmp/transcript.jsonl',
    },
    'claude',
    { POLYGRAPH_SESSION_ID: 'poly-session' }
  );

  assert.deepEqual(claim, {
    polygraphSessionId: 'poly-session',
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo',
    transcriptPath: '/tmp/transcript.jsonl',
    source: 'hook',
  });
});

test('PostToolUse claims do not depend on POLYGRAPH_SESSION_ID', () => {
  const claim = buildCommandHookClaim(
    {
      hook_event_name: 'PostToolUse',
      session_id: 'codex-thread',
      cwd: '/workspace/repo',
      transcript_path: '/tmp/rollout.jsonl',
      tool_name: 'mcp__polygraph-mcp__start_session',
      tool_input: {},
      tool_response: startResponse,
    },
    'codex',
    {}
  );

  assert.equal(claim.polygraphSessionId, 'merry-swan-123');
  assert.equal(claim.agentSessionId, 'codex-thread');
  assert.equal(claim.setResumeTarget, true);
});

test('child agents and read-only PostToolUse events never claim', () => {
  const sessionStart = {
    hook_event_name: 'SessionStart',
    session_id: 'child-session',
  };
  assert.equal(
    buildCommandHookClaim(sessionStart, 'claude', {
      POLYGRAPH_SESSION_ID: 'poly-session',
      POLYGRAPH_CHILD_AGENT: '1',
    }),
    undefined
  );
  assert.equal(
    buildCommandHookClaim(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'parent-session',
        tool_name: 'mcp__polygraph-mcp__show_session',
        tool_input: { sessionId: 'poly-session' },
        tool_response: { content: [] },
      },
      'claude',
      {}
    ),
    undefined
  );
});

test('the command hook invokes the CLI for a successful mutation claim', () => {
  let invocation;
  const result = main({
    agentType: 'claude',
    env: {},
    pid: 4321,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'claude-session',
      cwd: '/workspace/repo',
      tool_name: 'mcp__plugin_polygraph_polygraph-mcp__update_session',
      tool_input: { sessionId: 'poly-session', title: 'New title' },
      tool_response: { content: [{ type: 'text', text: 'Updated' }] },
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(result, true);
  assert.equal(invocation.command, 'polygraph');
  assert.ok(invocation.args.includes('poly-session'));
  assert.ok(invocation.args.includes('claude-session'));
  assert.ok(invocation.args.includes('4321'));
  assert.equal(invocation.args.includes('--set-resume-target'), false);
});

test('the command hook sets the resume target only after successful start_session', () => {
  let invocation;
  const result = main({
    agentType: 'codex',
    env: {},
    pid: 9876,
    payload: {
      hook_event_name: 'PostToolUse',
      session_id: 'codex-thread',
      cwd: '/workspace/repo',
      transcript_path: '/tmp/rollout.jsonl',
      tool_name: 'mcp__polygraph-mcp__start_session',
      tool_input: {},
      tool_response: startResponse,
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(result, true);
  assert.equal(invocation.command, 'polygraph');
  assert.equal(
    invocation.args.filter((arg) => arg === '--set-resume-target').length,
    1
  );
  assert.deepEqual(invocation.args.slice(-3), [
    '--set-resume-target',
    '--source',
    'hook',
  ]);
});
