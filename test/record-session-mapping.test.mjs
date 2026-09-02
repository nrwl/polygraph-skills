import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as linkModule from '../source/hooks/agent-session-link.mjs';
import {
  buildCommandHookLink,
  buildLinkAgentSessionArgs,
  isPolygraphMcpToolName,
  linkAgentSession,
  commandHookHarnessPid,
} from '../source/hooks/agent-session-link.mjs';
import { main } from '../source/hooks/record-session-mapping.mjs';
import {
  buildCommandHookFinalize,
  buildFinalizeAgentSessionArgs,
  FINALIZE_TIMEOUT_MS,
  finalizeAgentSession,
} from '../source/hooks/agent-session-finalize.mjs';
import { main as finalizeMain } from '../source/hooks/finalize-agent-session.mjs';

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
    if (relativePath === '../source/hooks/hooks.json') {
      assert.equal(hooks[0].hooks[0].async, true);
    }
  }
});

test('Claude lifecycle hooks link asynchronously and finalize synchronously', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../source/hooks/hooks.json', import.meta.url), 'utf8')
  );

  const sessionStart = manifest.hooks.SessionStart[0];
  const sessionStartMatcher = new RegExp(`^(?:${sessionStart.matcher})$`);
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    assert.equal(sessionStartMatcher.test(source), true, source);
  }
  assert.equal(sessionStartMatcher.test('other'), false);

  const sessionStartHooks = sessionStart.hooks;
  const linkHook = sessionStartHooks.find((hook) =>
    hook.command.includes('record-session-mapping.mjs')
  );
  assert.equal(linkHook.async, true);

  const sessionEndHook = manifest.hooks.SessionEnd[0].hooks[0];
  assert.match(sessionEndHook.command, /finalize-agent-session\.mjs claude/);
  assert.equal(Object.hasOwn(sessionEndHook, 'async'), false);
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
    'commandHookHarnessPid',
    'hookPayloadSessionId',
    'isPolygraphMcpToolName',
    'linkAgentSession',
    'logHookFailure',
  ]);

  const source = readFileSync(
    new URL('../source/hooks/agent-session-link.mjs', import.meta.url),
    'utf8'
  );
  // Cursor postToolUse forwards tool_input/tool_output VERBATIM as an opaque
  // --hook-operation payload (the CLI classifies it), so those field reads are
  // allowed. Parsing helpers and claim derivation must still stay out.
  for (const forbidden of [
    'SESSION_MUTATION_TOOLS',
    'derivePolygraphSessionClaim',
    'extractStartedSessionId',
    'parsePolygraphMutationTool',
    'tool_response',
    '--set-resume-target',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('builds a lifecycle link with exact session and capture metadata', () => {
  const { args, input } = buildLinkAgentSessionArgs({
    polygraphSessionId: 'poly/session?exact=true',
    agentType: 'codex',
    agentSessionId: 'codex/thread/root',
    cwd: '/workspace/repo with spaces',
    transcriptPath: '/tmp/rollout exact.jsonl',
    pid: 1234,
    source: 'hook',
  });
  assert.equal(input, undefined);
  assert.deepEqual(args, [
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
  ]);
});

test('builds a PostTool link without a Polygraph session or operation flags', () => {
  const { args, input } = buildLinkAgentSessionArgs({
    agentType: 'opencode',
    agentSessionId: 'oc-root',
    source: 'hook',
    setResumeTarget: true,
    operation: 'start_session',
  });
  assert.equal(input, undefined);
  assert.deepEqual(args, [
    '_link-agent-session',
    '--agent-type',
    'opencode',
    '--agent-session-id',
    'oc-root',
    '--source',
    'hook',
  ]);
});

test('uses the configured Polygraph CLI executable', () => {
  let invocation;
  const env = { POLYGRAPH_CLI: '/usr/local/bin/polygraph' };
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
  assert.equal(invocation.command, '/usr/local/bin/polygraph');
  assert.equal(invocation.args[0], '_link-agent-session');
  assert.equal(invocation.options.env.POLYGRAPH_CLI, env.POLYGRAPH_CLI);
});

test('runs a JS Polygraph CLI entry through Node up front, once', () => {
  // A .js/.mjs/.cjs entry (local package install, dev build without the
  // executable bit) is never executed directly: exactly one process launches
  // per link, and it is Node running the entry.
  const invocations = [];
  const env = { POLYGRAPH_CLI: '/workspace/dist/bin/polygraph.js' };
  assert.equal(
    linkAgentSession(
      {
        agentType: 'cursor',
        agentSessionId: 'cursor-root',
        source: 'hook',
      },
      (command, args, options) => {
        invocations.push({ command, args, options });
        return { status: 0, stderr: '' };
      },
      env
    ),
    true
  );
  assert.equal(invocations.length, 1);
  // The test process is Node, so the runtime is process.execPath.
  assert.equal(invocations[0].command, process.execPath);
  assert.equal(invocations[0].args[0], '/workspace/dist/bin/polygraph.js');
  assert.equal(invocations[0].args[1], '_link-agent-session');
  assert.equal(invocations[0].options.env.POLYGRAPH_CLI, env.POLYGRAPH_CLI);
});

test('contains spawn launch errors thrown synchronously (Bun) without retrying', () => {
  // Bun's spawnSync throws launch errors instead of returning them on the
  // result; the link must surface them as ordinary thrown errors after a
  // single attempt, never bypassing the error path or double-launching.
  const thrown = Object.assign(new Error('spawnSync EACCES'), { code: 'EACCES' });
  let spawnCount = 0;
  assert.throws(
    () =>
      linkAgentSession(
        {
          agentType: 'opencode',
          agentSessionId: 'opencode-root',
          source: 'hook',
        },
        () => {
          spawnCount += 1;
          throw thrown;
        },
        { POLYGRAPH_CLI: '/workspace/node_modules/.bin/polygraph.mjs' }
      ),
    thrown
  );
  assert.equal(spawnCount, 1);
});

test('does not retry a non-JS command that fails to launch', () => {
  const invocations = [];
  assert.throws(
    () =>
      linkAgentSession(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          source: 'hook',
        },
        (command, args, options) => {
          invocations.push({ command, args, options });
          return {
            error: Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' }),
          };
        },
        { POLYGRAPH_CLI: '/usr/local/bin/polygraph' }
      ),
    /ENOENT/
  );
  assert.equal(invocations.length, 1);
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

test('ordinary SessionStart forwards exact identity without a Polygraph session', () => {
  for (const agentType of ['claude', 'codex', 'opencode']) {
    assert.deepEqual(
      buildCommandHookLink(
        {
          hook_event_name: 'SessionStart',
          session_id: `${agentType}-session`,
          cwd: '/workspace/repo',
          transcript_path: '/tmp/transcript.jsonl',
        },
        agentType,
        {}
      ),
      {
        agentType,
        agentSessionId: `${agentType}-session`,
        cwd: '/workspace/repo',
        transcriptPath: '/tmp/transcript.jsonl',
        source: 'hook',
      },
      agentType
    );
  }

  assert.equal(
    buildCommandHookLink(
      { hook_event_name: 'SessionStart', session_id: 'other-session' },
      'unsupported-harness',
      {}
    ),
    undefined
  );
});

test('ordinary Codex SessionStart submits a speculative identity-only link', () => {
  let invocation;
  const result = main({
    agentType: 'codex',
    env: {},
    pid: 4321,
    payload: {
      hook_event_name: 'SessionStart',
      session_id: 'codex/root-thread',
      cwd: '/workspace/repo',
      transcript_path: '/tmp/rollout.jsonl',
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(result, true);
  assert.equal(invocation.args[0], '_link-agent-session');
  assert.equal(invocation.args.includes('--session'), false);
  assert.ok(invocation.args.includes('codex'));
  assert.ok(invocation.args.includes('codex/root-thread'));
  assert.ok(invocation.args.includes('/tmp/rollout.jsonl'));
  assert.deepEqual(invocation.args.slice(-4), ['--pid', '4321', '--source', 'hook']);
});

test('SessionEnd forwards only exact Claude lifecycle metadata', () => {
  const payload = {
    hook_event_name: 'SessionEnd',
    session_id: 'claude/root-session',
    cwd: '/workspace/exact repo',
    transcript_path: '/tmp/exact transcript.jsonl',
    reason: 'prompt_input_exit',
  };
  const claim = buildCommandHookFinalize(payload, 'claude', {
    POLYGRAPH_SESSION_ID: 'must-not-forward',
  });

  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude/root-session',
    cwd: '/workspace/exact repo',
    transcriptPath: '/tmp/exact transcript.jsonl',
    source: 'hook',
  });
  assert.deepEqual(buildFinalizeAgentSessionArgs(claim), [
    '_finalize-agent-session',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude/root-session',
    '--cwd',
    '/workspace/exact repo',
    '--transcript-path',
    '/tmp/exact transcript.jsonl',
    '--source',
    'hook',
  ]);
  assert.equal(buildCommandHookFinalize(payload, 'codex', {}), undefined);
  // Cursor finalizes on its own camelCase event, never on Claude's.
  assert.equal(buildCommandHookFinalize(payload, 'cursor', {}), undefined);
});

// Cursor sessionEnd payload shape from live cursor-agent --plugin-dir probes
// (2026.08.31): the id rides session_id and conversation_id, there is no
// top-level cwd, and transcript_path is populated by the time the
// conversation ends.
const CURSOR_SESSION_END_PAYLOAD = {
  conversation_id: 'cursor/conversation-id',
  generation_id: 'cursor/conversation-id',
  model: 'default',
  reason: 'user_close',
  duration_ms: 56452,
  is_background_agent: false,
  final_status: 'completed',
  session_id: 'cursor/conversation-id',
  hook_event_name: 'sessionEnd',
  cursor_version: '2026.08.31-4057e58',
  workspace_roots: ['/workspace/cursor repo'],
  user_email: 'someone@example.com',
  transcript_path: '/home/user/.cursor/projects/x/agent-transcripts/id/id.jsonl',
};

test('cursor sessionEnd builds a finalize claim from identity, workspace, and transcript only', () => {
  const claim = buildCommandHookFinalize(CURSOR_SESSION_END_PAYLOAD, 'cursor', {
    POLYGRAPH_SESSION_ID: 'must-not-forward',
  });
  assert.deepEqual(claim, {
    agentType: 'cursor',
    agentSessionId: 'cursor/conversation-id',
    cwd: '/workspace/cursor repo',
    transcriptPath: '/home/user/.cursor/projects/x/agent-transcripts/id/id.jsonl',
    source: 'hook',
  });
  assert.deepEqual(buildFinalizeAgentSessionArgs(claim), [
    '_finalize-agent-session',
    '--agent-type',
    'cursor',
    '--agent-session-id',
    'cursor/conversation-id',
    '--cwd',
    '/workspace/cursor repo',
    '--transcript-path',
    '/home/user/.cursor/projects/x/agent-transcripts/id/id.jsonl',
    '--source',
    'hook',
  ]);

  // conversation_id keeps finalization working if session_id disappears.
  const { session_id: _omitted, ...withoutSessionId } = CURSOR_SESSION_END_PAYLOAD;
  assert.equal(
    buildCommandHookFinalize(withoutSessionId, 'cursor', {}).agentSessionId,
    'cursor/conversation-id'
  );

  // Only Cursor's own camelCase event, never Claude's casing, another
  // harness, a managed child, or a payload without identity.
  assert.equal(
    buildCommandHookFinalize(
      { ...CURSOR_SESSION_END_PAYLOAD, hook_event_name: 'SessionEnd' },
      'cursor',
      {}
    ),
    undefined
  );
  assert.equal(buildCommandHookFinalize(CURSOR_SESSION_END_PAYLOAD, 'claude', {}), undefined);
  assert.equal(buildCommandHookFinalize(CURSOR_SESSION_END_PAYLOAD, 'codex', {}), undefined);
  assert.equal(
    buildCommandHookFinalize(CURSOR_SESSION_END_PAYLOAD, 'cursor', {
      POLYGRAPH_CHILD_AGENT: '1',
    }),
    undefined
  );
  assert.equal(
    buildCommandHookFinalize(
      { ...withoutSessionId, conversation_id: '' },
      'cursor',
      {}
    ),
    undefined
  );
  for (const eventName of ['stop', 'afterAgentResponse', 'beforeSubmitPrompt', 'sessionStart']) {
    assert.equal(
      buildCommandHookFinalize(
        { ...CURSOR_SESSION_END_PAYLOAD, hook_event_name: eventName },
        'cursor',
        {}
      ),
      undefined,
      eventName
    );
  }
});

test('cursor sessionEnd hands off to the detached finalize worker without a PID', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pg cursor repo-'));
  let invocation;
  let unrefCount = 0;
  const listeners = {};

  assert.equal(
    finalizeMain({
      agentType: 'cursor',
      env: {
        POLYGRAPH_SESSION_ID: 'ambient-session',
        POLYGRAPH_CAPTURE_TOKEN: 'ambient-token',
        REQUIRED_HARNESS_ENV: 'preserved',
      },
      payload: { ...CURSOR_SESSION_END_PAYLOAD, workspace_roots: [repo] },
      spawn(command, args, options) {
        invocation = { command, args, options };
        return {
          once(event, listener) {
            listeners[event] = listener;
            return this;
          },
          unref() {
            unrefCount += 1;
          },
        };
      },
      launcherOptions: { openLog: () => 1, closeLog: () => {} },
    }),
    true
  );

  assert.match(invocation.args[0], /finalize-agent-session-worker\.mjs$/);
  const claim = JSON.parse(invocation.args[1]);
  assert.deepEqual(claim, {
    agentType: 'cursor',
    agentSessionId: 'cursor/conversation-id',
    cwd: repo,
    transcriptPath: '/home/user/.cursor/projects/x/agent-transcripts/id/id.jsonl',
    source: 'hook',
  });
  assert.equal('pid' in claim, false);
  assert.equal(buildFinalizeAgentSessionArgs(claim).includes('--pid'), false);
  assert.equal(invocation.options.cwd, repo);
  rmSync(repo, { recursive: true, force: true });
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_SESSION_ID'), false);
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_CAPTURE_TOKEN'), false);
  assert.equal(invocation.options.env.REQUIRED_HARNESS_ENV, 'preserved');
  assert.equal(unrefCount, 1);
  assert.deepEqual(Object.keys(listeners), ['error']);

  // Managed children never finalize.
  assert.equal(
    finalizeMain({
      agentType: 'cursor',
      env: { POLYGRAPH_CHILD_AGENT: '1' },
      payload: CURSOR_SESSION_END_PAYLOAD,
      spawn() {
        throw new Error('spawn must not run for managed children');
      },
      launcherOptions: { openLog: () => 1, closeLog: () => {} },
    }),
    false
  );
});

test('detached finalization enforces a bounded 90-second CLI kill deadline', () => {
  let invocation;

  assert.equal(
    finalizeAgentSession(
      {
        agentType: 'claude',
        agentSessionId: 'claude-session',
        cwd: '/workspace/repo',
        source: 'hook',
      },
      (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: '', stderr: '' };
      },
      { POLYGRAPH_CLI: '/opt/polygraph' },
      { timeoutMs: FINALIZE_TIMEOUT_MS * 2, now: () => 1_000 }
    ),
    true
  );

  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert.equal(invocation.options.timeout, FINALIZE_TIMEOUT_MS);
});

test('SessionEnd hook hands off to a detached worker, strips ambient evidence, and excludes children', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pg repo with spaces-'));
  let invocation;
  let unrefCount = 0;
  const logEvents = [];
  const env = {
    POLYGRAPH_CLI: '/workspace/dist/bin/polygraph.js',
    POLYGRAPH_SESSION_ID: 'ambient-session',
    POLYGRAPH_CAPTURE_TOKEN: 'ambient-token',
  };
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    logEvents.push('spawn');
    return {
      once() {
        return this;
      },
      unref() {
        unrefCount += 1;
      },
    };
  };

  assert.equal(
    finalizeMain({
      agentType: 'claude',
      env,
      payload: {
        hook_event_name: 'SessionEnd',
        session_id: 'claude-session',
        cwd: repo,
        transcript_path: '/tmp/transcript exact.jsonl',
      },
      spawn,
      launcherOptions: {
        execPath: '/runtime/node',
        openLog: () => {
          logEvents.push('open');
          return 42;
        },
        closeLog: (fd) => {
          logEvents.push(['close', fd]);
        },
      },
    }),
    true
  );

  assert.equal(invocation.command, '/runtime/node');
  assert.match(invocation.args[0], /finalize-agent-session-worker\.mjs$/);
  assert.deepEqual(JSON.parse(invocation.args[1]), {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: repo,
    transcriptPath: '/tmp/transcript exact.jsonl',
    source: 'hook',
  });
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_SESSION_ID'), false);
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_CAPTURE_TOKEN'), false);
  assert.equal(invocation.options.env.POLYGRAPH_CLI, env.POLYGRAPH_CLI);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.cwd, repo);
  assert.deepEqual(invocation.options.stdio, ['ignore', 42, 42]);
  assert.equal(unrefCount, 1);
  // The log stays open across the launch, then the parent's copy closes; the
  // worker keeps its inherited descriptors for durable failure logging.
  assert.deepEqual(logEvents, ['open', 'spawn', ['close', 42]]);

  let childSpawnCount = 0;
  assert.equal(
    finalizeAgentSession(
      {
        agentType: 'claude',
        agentSessionId: 'child-session',
        source: 'hook',
      },
      () => {
        childSpawnCount += 1;
        return {};
      },
      { POLYGRAPH_CHILD_AGENT: '' }
    ),
    false
  );
  assert.equal(childSpawnCount, 0);
  rmSync(repo, { recursive: true, force: true });
});

test('SessionEnd hook observes only worker launch failures', () => {
  const listeners = {};
  const failures = [];
  const result = finalizeMain({
    agentType: 'claude',
    env: {},
    payload: {
      hook_event_name: 'SessionEnd',
      session_id: 'claude-session',
    },
    spawn() {
      return {
        once(event, listener) {
          listeners[event] = listener;
          return this;
        },
        unref() {},
      };
    },
    logFailure(hook, error, meta) {
      failures.push({ hook, error, meta });
    },
    launcherOptions: { openLog: () => 1, closeLog: () => {} },
  });

  assert.equal(result, true);
  // CLI exit handling belongs to the detached worker: the short-lived hook
  // registers no exit listener because it cannot outlive harness shutdown.
  assert.deepEqual(Object.keys(listeners), ['error']);

  const spawnError = new Error('spawn failed');
  listeners.error(spawnError);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].hook, 'claude:finalize-agent-session');
  assert.equal(failures[0].error, spawnError);
  assert.deepEqual(failures[0].meta, {
    hookEventName: 'SessionEnd',
    agentSessionId: 'claude-session',
  });
});

test('cursor hook failure diagnostics name the session by conversation_id when session_id is absent', () => {
  // Cursor's prompt and agent-done payloads carry only conversation_id.
  const cursorPayload = (hookEventName) => ({
    hook_event_name: hookEventName,
    conversation_id: 'cursor/conversation-id',
    workspace_roots: ['/workspace/cursor repo'],
  });

  const finalizeFailures = [];
  assert.equal(
    finalizeMain({
      agentType: 'cursor',
      env: {},
      payload: cursorPayload('sessionEnd'),
      spawn() {
        throw new Error('handoff failed');
      },
      logFailure(hook, _error, meta) {
        finalizeFailures.push({ hook, meta });
      },
      launcherOptions: { openLog: () => 1, closeLog: () => {} },
    }),
    false
  );
  assert.deepEqual(finalizeFailures, [
    {
      hook: 'cursor:finalize-agent-session',
      meta: { hookEventName: 'sessionEnd', agentSessionId: 'cursor/conversation-id' },
    },
  ]);

  const linkFailures = [];
  assert.equal(
    main({
      agentType: 'cursor',
      env: {},
      payload: {
        ...cursorPayload('postToolUse'),
        tool_name: 'MCP:spawn_agent',
        tool_input: {},
        tool_output: {},
      },
      spawn: () => ({ status: 3, stderr: 'link refused' }),
      logFailure(hook, _error, meta) {
        linkFailures.push({ hook, meta });
      },
    }),
    false
  );
  assert.deepEqual(linkFailures, [
    {
      hook: 'cursor:link-agent-session',
      meta: { hookEventName: 'postToolUse', agentSessionId: 'cursor/conversation-id' },
    },
  ]);
});

test('SessionEnd hook contains synchronous handoff failures', () => {
  const failure = new Error('handoff failed');
  let loggedError;

  assert.equal(
    finalizeMain({
      agentType: 'claude',
      env: {},
      payload: {
        hook_event_name: 'SessionEnd',
        session_id: 'claude-session',
      },
      spawn() {
        throw failure;
      },
      logFailure(_hook, error) {
        loggedError = error;
      },
      launcherOptions: { openLog: () => 1, closeLog: () => {} },
    }),
    false
  );
  assert.equal(loggedError, failure);
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
    assert.equal(invocation.args.includes('--pid'), agentType !== 'claude');
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

test('the cursor plugin registers static relative lifecycle, claim, and wake hooks', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../source/cursor/hooks/hooks.json', import.meta.url), 'utf8')
  );

  // Cursor's native hook config format, not the Claude/Codex one.
  assert.equal(manifest.version, 1);
  const sessionStartHooks = manifest.hooks.sessionStart;
  assert.equal(sessionStartHooks.length, 1);

  // Cursor runs plugin hook commands with cwd set to the plugin root, so
  // the command must stay a plain relative invocation: no absolute paths,
  // no ${PLUGIN_ROOT}-style variables.
  assert.equal(
    sessionStartHooks[0].command,
    'node hooks/record-session-mapping.mjs cursor'
  );

  // Claim evidence rides postToolUse.
  const postToolUseHooks = manifest.hooks.postToolUse;
  assert.equal(postToolUseHooks.length, 1);
  assert.equal(
    postToolUseHooks[0].command,
    'node hooks/record-session-mapping.mjs cursor'
  );

  // The prompt wake detaches: beforeSubmitPrompt is a blocking hook, so the
  // registered command must return immediately and emit nothing on stdout.
  const promptHooks = manifest.hooks.beforeSubmitPrompt;
  assert.equal(promptHooks.length, 1);
  assert.equal(
    promptHooks[0].command,
    'node hooks/ensure-agent-session-capture.mjs cursor --detach'
  );

  // The agent-done wakes ride Cursor's observational afterAgentResponse
  // (per completed assistant message) and stop (agent loop end) hooks with
  // the same detached, identity-only command as the prompt wake. Neither
  // emits anything on stdout, so stop can never auto-submit a follow-up.
  for (const eventName of ['afterAgentResponse', 'stop']) {
    const wakeHooks = manifest.hooks[eventName];
    assert.equal(wakeHooks.length, 1, eventName);
    assert.equal(wakeHooks[0].command, promptHooks[0].command, eventName);
  }

  // sessionEnd finalizes through the detached worker; the hook itself
  // returns immediately and emits nothing on stdout.
  const sessionEndHooks = manifest.hooks.sessionEnd;
  assert.equal(sessionEndHooks.length, 1);
  assert.equal(
    sessionEndHooks[0].command,
    'node hooks/finalize-agent-session.mjs cursor'
  );

  // Every registration lives in the plugin manifest; nothing may prompt a
  // user-scope ~/.cursor/hooks.json registration.
  assert.deepEqual(Object.keys(manifest.hooks).sort(), [
    'afterAgentResponse',
    'beforeSubmitPrompt',
    'postToolUse',
    'sessionEnd',
    'sessionStart',
    'stop',
  ]);
});

test('cursor sessionStart forwards lifecycle identity from the cursor payload shape', () => {
  assert.deepEqual(
    buildCommandHookLink(
      {
        hook_event_name: 'sessionStart',
        session_id: 'cursor/conversation-id',
        conversation_id: 'cursor/conversation-id',
        workspace_roots: ['/workspace/exact repo'],
        transcript_path: null,
      },
      'cursor',
      { POLYGRAPH_SESSION_ID: 'poly/exact-session' }
    ),
    {
      polygraphSessionId: 'poly/exact-session',
      agentType: 'cursor',
      agentSessionId: 'cursor/conversation-id',
      cwd: '/workspace/exact repo',
      transcriptPath: undefined,
      source: 'hook',
    }
  );
});

test('cursor sessionStart falls back to conversation_id for identity', () => {
  const link = buildCommandHookLink(
    {
      hook_event_name: 'sessionStart',
      conversation_id: 'cursor/only-conversation',
      workspace_roots: ['/workspace/repo'],
    },
    'cursor',
    {}
  );
  assert.equal(link.agentSessionId, 'cursor/only-conversation');
});

test('ordinary cursor sessionStart submits a speculative identity-only link', () => {
  let invocation;
  const result = main({
    agentType: 'cursor',
    env: {},
    pid: 8765,
    payload: {
      hook_event_name: 'sessionStart',
      session_id: 'cursor/root-conversation',
      conversation_id: 'cursor/root-conversation',
      workspace_roots: ['/workspace/repo'],
      transcript_path: null,
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(result, true);
  assert.equal(invocation.args[0], '_link-agent-session');
  assert.equal(invocation.args.includes('--session'), false);
  assert.ok(invocation.args.includes('cursor'));
  assert.ok(invocation.args.includes('cursor/root-conversation'));
  assert.ok(invocation.args.includes('/workspace/repo'));
  assert.equal(invocation.args.includes('--transcript-path'), false);
  // Cursor's hook parent is a transient shell wrapper, never cursor-agent.
  assert.equal(invocation.args.includes('--pid'), false);
  assert.deepEqual(invocation.args.slice(-2), ['--source', 'hook']);
});

test('cursor links never bind a mapping to the transient hook-runner PID', () => {
  const hookRunnerPid = 66900;
  const payloads = [
    {
      hook_event_name: 'sessionStart',
      session_id: 'cursor/root-conversation',
      conversation_id: 'cursor/root-conversation',
      workspace_roots: ['/workspace/repo'],
      transcript_path: null,
    },
    CURSOR_POST_TOOL_USE_PAYLOAD,
  ];

  for (const env of [
    {},
    {
      POLYGRAPH_SESSION_ID: 'poly/launched-session',
      POLYGRAPH_CAPTURE_TOKEN: 'capture-token-1',
    },
  ]) {
    for (const payload of payloads) {
      let invocation;
      assert.equal(
        main({
          agentType: 'cursor',
          env,
          pid: hookRunnerPid,
          payload,
          spawn(command, args, options) {
            invocation = { command, args, options };
            return { status: 0, stderr: '' };
          },
        }),
        true,
        payload.hook_event_name
      );
      assert.equal(invocation.args[0], '_link-agent-session');
      assert.equal(invocation.args.includes('--pid'), false, payload.hook_event_name);
      assert.equal(invocation.args.includes(String(hookRunnerPid)), false);
    }
  }

  assert.equal(
    commandHookHarnessPid('cursor', { hook_event_name: 'sessionStart' }, hookRunnerPid),
    undefined
  );
  assert.equal(
    commandHookHarnessPid('cursor', { hook_event_name: 'postToolUse' }, hookRunnerPid),
    undefined
  );
  // Claude SessionStart stays PID-less; other Claude and Codex links keep the
  // hook's parent PID exactly as before.
  assert.equal(
    commandHookHarnessPid('claude', { hook_event_name: 'SessionStart' }, 4321),
    undefined
  );
  assert.equal(
    commandHookHarnessPid('claude', { hook_event_name: 'PostToolUse' }, 4321),
    4321
  );
  assert.equal(
    commandHookHarnessPid('codex', { hook_event_name: 'SessionStart' }, 4321),
    4321
  );
  for (const invalid of [0, -1, 1.5, NaN, undefined, '4321']) {
    assert.equal(
      commandHookHarnessPid('codex', { hook_event_name: 'PostToolUse' }, invalid),
      undefined,
      String(invalid)
    );
  }
});

test('polygraph-launched cursor sessionStart links with session and capture evidence', () => {
  let invocation;
  const result = main({
    agentType: 'cursor',
    env: {
      POLYGRAPH_SESSION_ID: 'poly/launched-session',
      POLYGRAPH_CAPTURE_TOKEN: 'capture-token-1',
    },
    pid: 8765,
    payload: {
      hook_event_name: 'sessionStart',
      session_id: 'cursor/root-conversation',
      workspace_roots: ['/workspace/repo'],
      transcript_path: null,
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(result, true);
  assert.deepEqual(invocation.args.slice(0, 3), [
    '_link-agent-session',
    '--session',
    'poly/launched-session',
  ]);
  // The capture token travels in env; _link-agent-session reads it there.
  assert.equal(
    invocation.options.env.POLYGRAPH_CAPTURE_TOKEN,
    'capture-token-1'
  );
});

test('managed cursor children never invoke the shared link command', () => {
  const result = main({
    agentType: 'cursor',
    env: { POLYGRAPH_CHILD_AGENT: '1', POLYGRAPH_SESSION_ID: 'poly/session' },
    payload: {
      hook_event_name: 'sessionStart',
      session_id: 'cursor/child-conversation',
      workspace_roots: ['/workspace/repo'],
    },
    spawn() {
      throw new Error('spawn must not run for managed children');
    },
  });

  assert.equal(result, false);
});

// Cursor postToolUse payload shape from a live probe (2026-08-27): MCP tools
// report as `MCP:<tool>` with no server namespace, tool_input is an object,
// and tool_output is the JSON-encoded MCP result string.
const CURSOR_POST_TOOL_USE_PAYLOAD = {
  hook_event_name: 'postToolUse',
  conversation_id: 'cursor/conversation-id',
  session_id: 'cursor/conversation-id',
  generation_id: 'gen-1',
  tool_name: 'MCP:start_session',
  tool_input: { description: 'Fix flaky tests', repos: ['org/repo'] },
  tool_output:
    '{"content":[{"type":"text","text":"Session poly-started (new)"}],"isError":false}',
  duration: 1234,
  tool_use_id: 'tool-use-1',
  workspace_roots: ['/workspace/repo'],
  transcript_path: '/home/user/.cursor/projects/x/agent-transcripts/id/id.jsonl',
};

test('cursor postToolUse forwards the whole operation as verbatim hook evidence', () => {
  assert.deepEqual(
    buildCommandHookLink(CURSOR_POST_TOOL_USE_PAYLOAD, 'cursor', {}),
    {
      agentType: 'cursor',
      agentSessionId: 'cursor/conversation-id',
      cwd: '/workspace/repo',
      transcriptPath:
        '/home/user/.cursor/projects/x/agent-transcripts/id/id.jsonl',
      source: 'hook',
      hookOperation: {
        toolName: 'MCP:start_session',
        toolInput: CURSOR_POST_TOOL_USE_PAYLOAD.tool_input,
        toolOutput: CURSOR_POST_TOOL_USE_PAYLOAD.tool_output,
      },
    }
  );
});

test('cursor postToolUse skips tools outside the claim-worthy MCP set', () => {
  for (const toolName of [
    'MCP:list_sessions', // read-only Polygraph tool: no claim policy
    'MCP:show_session',
    'Read', // built-in tool
    'Shell',
    'MCP:', // malformed
    'start_session', // missing the MCP: prefix
    undefined,
  ]) {
    assert.equal(
      buildCommandHookLink(
        { ...CURSOR_POST_TOOL_USE_PAYLOAD, tool_name: toolName },
        'cursor',
        {}
      ),
      undefined,
      String(toolName)
    );
  }
});

test('buildLinkAgentSessionArgs sends the hook operation on stdin, never argv', () => {
  const { args, input } = buildLinkAgentSessionArgs({
    agentType: 'cursor',
    agentSessionId: 'cursor/conversation-id',
    source: 'hook',
    hookOperation: {
      toolName: 'MCP:start_session',
      toolInput: { description: 'Fix flaky tests' },
      toolOutput: '{"content":[],"isError":false}',
    },
  });

  assert.notEqual(args.indexOf('--hook-operation-stdin'), -1);
  assert.equal(args.indexOf('--hook-operation'), -1);
  assert.deepEqual(JSON.parse(input), {
    toolName: 'MCP:start_session',
    toolInput: { description: 'Fix flaky tests' },
    toolOutput: '{"content":[],"isError":false}',
  });
  assert.deepEqual(args.slice(-2), ['--source', 'hook']);
});

test('an oversized hook operation stays off argv entirely', () => {
  // Linux caps one argv string at 128KB (MAX_ARG_STRLEN); a full
  // upload_artifact content in toolInput would kill the spawn with E2BIG if
  // it rode an argument. On stdin, size is the CLI's problem, not exec's.
  const content = 'x'.repeat(300_000);
  const { args, input } = buildLinkAgentSessionArgs({
    agentType: 'cursor',
    agentSessionId: 'cursor/conversation-id',
    source: 'hook',
    hookOperation: {
      toolName: 'MCP:upload_artifact',
      toolInput: { content },
      toolOutput: '{"content":[],"isError":false}',
    },
  });

  assert.equal(input.length > content.length, true);
  for (const arg of args) {
    assert.equal(
      arg.length < 4096,
      true,
      `argv entry unexpectedly large: ${arg.slice(0, 80)}...`
    );
  }
});

test('cursor postToolUse invokes the link command with the hook operation', () => {
  let invocation;
  const result = main({
    agentType: 'cursor',
    env: {},
    pid: 8765,
    payload: CURSOR_POST_TOOL_USE_PAYLOAD,
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
  });

  assert.equal(result, true);
  assert.equal(invocation.args[0], '_link-agent-session');
  assert.equal(invocation.args.includes('--pid'), false);
  assert.notEqual(invocation.args.indexOf('--hook-operation-stdin'), -1);
  assert.equal(invocation.args.indexOf('--hook-operation'), -1);
  assert.equal(
    JSON.parse(invocation.options.input).toolName,
    'MCP:start_session'
  );
  // stdin must actually be wired for the input to reach the CLI.
  assert.equal(invocation.options.stdio[0], 'pipe');
});

test('managed cursor children never forward postToolUse evidence', () => {
  const result = main({
    agentType: 'cursor',
    env: { POLYGRAPH_CHILD_AGENT: '1' },
    payload: CURSOR_POST_TOOL_USE_PAYLOAD,
    spawn() {
      throw new Error('spawn must not run for managed children');
    },
  });

  assert.equal(result, false);
});
