import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  buildCommandHookEnsureCapture,
  buildEnsureAgentSessionCaptureArgs,
  ENSURE_CAPTURE_TIMEOUT_MS,
  ENSURE_CAPTURE_UNSUPPORTED_MARKER,
  ensureAgentSessionCapture,
} from '../source/hooks/agent-session-capture.mjs';
import { main } from '../source/hooks/ensure-agent-session-capture.mjs';

test('Claude registers asynchronous UserPromptSubmit and Stop wake hooks with a shipped command artifact', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../source/hooks/hooks.json', import.meta.url), 'utf8')
  );

  for (const eventName of ['UserPromptSubmit', 'Stop']) {
    const eventHooks = manifest.hooks[eventName];
    assert.equal(eventHooks.length, 1, eventName);
    assert.equal(eventHooks[0].hooks.length, 1, eventName);

    const hook = eventHooks[0].hooks[0];
    assert.equal(hook.type, 'command', eventName);
    assert.equal(
      hook.command,
      'node ${CLAUDE_PLUGIN_ROOT}/hooks/ensure-agent-session-capture.mjs claude',
      eventName
    );
    assert.equal(hook.async, true, eventName);
  }

  assert.equal(
    existsSync(
      new URL('../source/hooks/ensure-agent-session-capture.mjs', import.meta.url)
    ),
    true
  );
});

test('UserPromptSubmit wakes capture with the same claim as Stop and forwards no prompt text', () => {
  const claim = buildCommandHookEnsureCapture(
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      cwd: '/workspace/repo with spaces',
      transcript_path: '/tmp/transcript exact.jsonl',
      prompt: 'must-never-leave-the-transcript',
    },
    'claude',
    {}
  );

  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo with spaces',
    transcriptPath: '/tmp/transcript exact.jsonl',
    source: 'hook',
  });
  assert.equal(
    buildEnsureAgentSessionCaptureArgs(claim).some((arg) =>
      arg.includes('must-never-leave-the-transcript')
    ),
    false
  );
});

test('Stop payload forwards exact Claude session metadata', () => {
  const payload = {
    hook_event_name: 'Stop',
    session_id: 'claude/root session?exact=true',
    cwd: '/workspace/repo with spaces',
    transcript_path: '/tmp/transcript exact.jsonl',
    stop_hook_active: false,
  };

  const claim = buildCommandHookEnsureCapture(payload, 'claude', {});
  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude/root session?exact=true',
    cwd: '/workspace/repo with spaces',
    transcriptPath: '/tmp/transcript exact.jsonl',
    source: 'hook',
  });
  assert.deepEqual(buildEnsureAgentSessionCaptureArgs(claim), [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude/root session?exact=true',
    '--cwd',
    '/workspace/repo with spaces',
    '--transcript-path',
    '/tmp/transcript exact.jsonl',
    '--source',
    'hook',
  ]);
});

test('Stop payload omits absent optional metadata', () => {
  const claim = buildCommandHookEnsureCapture(
    {
      hook_event_name: 'Stop',
      session_id: 'claude-session',
      cwd: '   ',
      transcript_path: undefined,
    },
    'claude',
    {}
  );

  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: undefined,
    transcriptPath: undefined,
    source: 'hook',
  });
  assert.deepEqual(buildEnsureAgentSessionCaptureArgs(claim), [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
    '--source',
    'hook',
  ]);
});

test('capture hook accepts only complete Claude wake payloads', () => {
  const valid = { hook_event_name: 'Stop', session_id: 'claude-session' };

  for (const payload of [
    undefined,
    null,
    [],
    {},
    { session_id: 'claude-session' },
    { ...valid, hook_event_name: 'stop' },
    { ...valid, hook_event_name: 'SubagentStop' },
    { ...valid, hook_event_name: 'PreToolUse' },
    { ...valid, hook_event_name: 'PostToolUse' },
    { ...valid, hook_event_name: 'SessionEnd' },
    { ...valid, session_id: '' },
  ]) {
    assert.equal(buildCommandHookEnsureCapture(payload, 'claude', {}), undefined);
  }

  assert.equal(buildCommandHookEnsureCapture(valid, 'codex', {}), undefined);
});

test('managed Polygraph children never ensure capture', () => {
  const env = { POLYGRAPH_CHILD_AGENT: '' };
  const payload = { hook_event_name: 'Stop', session_id: 'claude-child' };
  let spawnCount = 0;

  assert.equal(buildCommandHookEnsureCapture(payload, 'claude', env), undefined);
  assert.equal(
    ensureAgentSessionCapture(
      { agentType: 'claude', agentSessionId: 'claude-child' },
      () => {
        spawnCount += 1;
        return { status: 0, stderr: '' };
      },
      env
    ),
    false
  );
  assert.equal(spawnCount, 0);
});

test('Stop launcher invokes only the configured hidden CLI command', () => {
  let invocation;
  const env = {
    POLYGRAPH_CLI: '/workspace/dist/bin/polygraph.js',
    POLYGRAPH_SESSION_ID: 'ambient-session',
    POLYGRAPH_CAPTURE_TOKEN: 'ambient-token',
    REQUIRED_HARNESS_ENV: 'preserved',
  };

  assert.equal(
    main({
      agentType: 'claude',
      env,
      payload: {
        hook_event_name: 'Stop',
        session_id: 'claude-session',
        cwd: '/workspace/repo',
        transcript_path: '/tmp/transcript.jsonl',
      },
      spawn(command, args, options) {
        invocation = { command, args, options };
        return { status: 0, stderr: '' };
      },
    }),
    true
  );

  assert.equal(invocation.command, env.POLYGRAPH_CLI);
  assert.deepEqual(invocation.args, [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
    '--cwd',
    '/workspace/repo',
    '--transcript-path',
    '/tmp/transcript.jsonl',
    '--source',
    'hook',
  ]);
  assert.equal(invocation.options.cwd, '/workspace/repo');
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert.ok(invocation.options.timeout <= ENSURE_CAPTURE_TIMEOUT_MS);
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_SESSION_ID'), false);
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_CAPTURE_TOKEN'), false);
  assert.equal(invocation.options.env.REQUIRED_HARNESS_ENV, 'preserved');
});

test('Stop launcher logs CLI failures best-effort without failing the hook', () => {
  let logged;
  const result = main({
    agentType: 'claude',
    env: {},
    payload: { hook_event_name: 'Stop', session_id: 'claude-session' },
    spawn: () => ({ status: 2, stderr: 'capture unavailable' }),
    logFailure(hook, error, meta) {
      logged = { hook, error, meta };
    },
  });

  assert.equal(result, false);
  assert.equal(logged.hook, 'claude:ensure-agent-session-capture');
  assert.match(logged.error.message, /status 2: capture unavailable/);
  assert.deepEqual(logged.meta, {
    hookEventName: 'Stop',
    agentSessionId: 'claude-session',
  });
});

test('Stop launcher also contains spawn errors', () => {
  const failure = new Error('spawn failed');
  let loggedError;

  assert.equal(
    main({
      agentType: 'claude',
      env: {},
      payload: { hook_event_name: 'Stop', session_id: 'claude-session' },
      spawn: () => ({ error: failure }),
      logFailure(_hook, error) {
        loggedError = error;
      },
    }),
    false
  );
  assert.equal(loggedError, failure);
});

test('Stop uses one strict bounded deadline across version-skew fallback', () => {
  const invocations = [];
  const times = [1_000, 1_100, 5_700];
  const claim = {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo',
    source: 'hook',
  };

  assert.equal(
    ensureAgentSessionCapture(
      claim,
      (command, args, options) => {
        invocations.push({ command, args, options });
        return invocations.length === 1
          ? { status: 2, stderr: ENSURE_CAPTURE_UNSUPPORTED_MARKER }
          : { status: 0, stderr: '' };
      },
      { POLYGRAPH_CLI: '/opt/polygraph' },
      {
        timeoutMs: ENSURE_CAPTURE_TIMEOUT_MS * 2,
        now: () => times.shift(),
      }
    ),
    true
  );

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].args[0], '_ensure-agent-session-capture');
  assert.equal(invocations[1].args[0], '_link-agent-session');
  assert.equal(invocations[0].options.timeout, 4_900);
  assert.equal(invocations[1].options.timeout, 300);
  assert.equal(invocations[0].options.killSignal, 'SIGKILL');
  assert.equal(invocations[1].options.killSignal, 'SIGKILL');
});

test('Stop never retries a timed-out or ambiguously executed command', () => {
  let spawnCount = 0;
  const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });

  assert.throws(
    () =>
      ensureAgentSessionCapture(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: '/workspace/repo',
          source: 'hook',
        },
        () => {
          spawnCount += 1;
          return {
            error: timeout,
            status: null,
            signal: 'SIGKILL',
            stderr: ENSURE_CAPTURE_UNSUPPORTED_MARKER,
          };
        },
        {}
      ),
    timeout
  );
  assert.equal(spawnCount, 1);
});

test('Stop preserves the JavaScript entry fallback without duplicate execution', () => {
  const invocations = [];
  const launchError = Object.assign(new Error('not executable'), { code: 'EACCES' });
  const claim = {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo',
    source: 'hook',
  };

  assert.equal(
    ensureAgentSessionCapture(
      claim,
      (command, args, options) => {
        invocations.push({ command, args, options });
        return invocations.length === 1
          ? { error: launchError }
          : { status: 0, stderr: '' };
      },
      { POLYGRAPH_CLI: '/opt/polygraph.mjs' },
      { execPath: '/runtime/node', now: () => 10 }
    ),
    true
  );

  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].command, '/opt/polygraph.mjs');
  assert.equal(invocations[1].command, '/runtime/node');
  assert.deepEqual(invocations[1].args, [
    '/opt/polygraph.mjs',
    ...invocations[0].args,
  ]);
});

test('repeated Stop wakes remain identical and do not mutate ambient evidence', () => {
  const env = {
    POLYGRAPH_CLI: '/opt/polygraph',
    POLYGRAPH_SESSION_ID: 'ambient-session',
    POLYGRAPH_CAPTURE_TOKEN: 'ambient-token',
  };
  const claim = {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo',
    source: 'hook',
  };
  const invocations = [];
  const spawn = (command, args, options) => {
    invocations.push({ command, args, options });
    return { status: 0, stderr: '' };
  };

  assert.equal(ensureAgentSessionCapture(claim, spawn, env), true);
  assert.equal(ensureAgentSessionCapture(claim, spawn, env), true);
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].args, invocations[1].args);
  assert.equal(Object.hasOwn(invocations[0].options.env, 'POLYGRAPH_SESSION_ID'), false);
  assert.equal(Object.hasOwn(invocations[1].options.env, 'POLYGRAPH_CAPTURE_TOKEN'), false);
  assert.equal(env.POLYGRAPH_SESSION_ID, 'ambient-session');
  assert.equal(env.POLYGRAPH_CAPTURE_TOKEN, 'ambient-token');
});
