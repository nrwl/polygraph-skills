import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  buildCommandHookEnsureCapture,
  buildEnsureAgentSessionCaptureArgs,
  buildLegacyCaptureWakeArgs,
  ENSURE_CAPTURE_TIMEOUT_MS,
  ENSURE_CAPTURE_UNSUPPORTED_MARKER,
  ensureAgentSessionCapture,
  launchAgentSessionCaptureWake,
} from '../source/hooks/agent-session-capture.mjs';
import { main } from '../source/hooks/ensure-agent-session-capture.mjs';

// A fixed hook-fire time: every wake forwards the hook's own clock reading.
const HOOK_FIRED_AT = 1_767_225_600_000;
const OBSERVED_AT_ARGS = ['--observed-at', String(HOOK_FIRED_AT)];

const OLD_CLI_UNSUPPORTED_STDOUT = `Usage: polygraph
Polygraph CLI for cross-repo coordination

Commands:
  auth - Authentication and environment selection

Validation failed for one or more options
  - Unknown argument: _ensure-agent-session-capture
  - Unknown argument: --agent-type
  - Unknown argument: claude
  - Unknown argument: --agent-session-id
  - Unknown argument: claude-session
`;

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

test('Codex registers detached UserPromptSubmit and Stop wake hooks', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../source/codex/hooks/hooks.json', import.meta.url),
      'utf8'
    )
  );

  // Codex hook manifests have no async flag, so the wake detaches itself.
  for (const eventName of ['UserPromptSubmit', 'Stop']) {
    const eventHooks = manifest.hooks[eventName];
    assert.equal(eventHooks.length, 1, eventName);
    assert.equal(eventHooks[0].hooks.length, 1, eventName);

    const hook = eventHooks[0].hooks[0];
    assert.equal(hook.type, 'command', eventName);
    assert.equal(
      hook.command,
      'node ${PLUGIN_ROOT}/hooks/ensure-agent-session-capture.mjs codex --detach',
      eventName
    );
  }
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
    {},
    () => HOOK_FIRED_AT
  );

  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo with spaces',
    transcriptPath: '/tmp/transcript exact.jsonl',
    observedAt: HOOK_FIRED_AT,
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

  const claim = buildCommandHookEnsureCapture(payload, 'claude', {}, () => HOOK_FIRED_AT);
  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude/root session?exact=true',
    cwd: '/workspace/repo with spaces',
    transcriptPath: '/tmp/transcript exact.jsonl',
    observedAt: HOOK_FIRED_AT,
  });
  // Identity plus the hook-fire time: no --source on the ensure command — a
  // liveness poke carries no mapping provenance and no semantic status.
  assert.deepEqual(buildEnsureAgentSessionCaptureArgs(claim), [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude/root session?exact=true',
    ...OBSERVED_AT_ARGS,
  ]);
  assert.deepEqual(buildLegacyCaptureWakeArgs(claim), [
    '_link-agent-session',
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
    {},
    () => HOOK_FIRED_AT
  );

  assert.deepEqual(claim, {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: undefined,
    transcriptPath: undefined,
    observedAt: HOOK_FIRED_AT,
  });
  assert.deepEqual(buildEnsureAgentSessionCaptureArgs(claim), [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
    ...OBSERVED_AT_ARGS,
  ]);
});

test('an ensure wake without the hook-captured time is refused, never guessed', () => {
  for (const observedAt of [undefined, null, 0, -1, 1.5, NaN, '1767225600000']) {
    assert.throws(
      () =>
        buildEnsureAgentSessionCaptureArgs({
          agentType: 'claude',
          agentSessionId: 'claude-session',
          observedAt,
        }),
      /observedAt is required/,
      String(observedAt)
    );
  }
  // The legacy mapping command never carries the timestamp at all.
  assert.deepEqual(
    buildLegacyCaptureWakeArgs({
      agentType: 'claude',
      agentSessionId: 'claude-session',
      observedAt: HOOK_FIRED_AT,
    }),
    ['_link-agent-session', '--agent-type', 'claude', '--agent-session-id', 'claude-session', '--source', 'hook']
  );
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

  assert.equal(buildCommandHookEnsureCapture(valid, 'gemini', {}), undefined);
});

test('codex wakes on the same PascalCase events as Claude', () => {
  for (const eventName of ['UserPromptSubmit', 'Stop']) {
    assert.deepEqual(
      buildCommandHookEnsureCapture(
        {
          hook_event_name: eventName,
          session_id: 'codex/root-thread',
          cwd: '/workspace/repo with spaces',
          transcript_path: '/tmp/rollout exact.jsonl',
        },
        'codex',
        {},
        () => HOOK_FIRED_AT
      ),
      {
        agentType: 'codex',
        agentSessionId: 'codex/root-thread',
        cwd: '/workspace/repo with spaces',
        transcriptPath: '/tmp/rollout exact.jsonl',
        observedAt: HOOK_FIRED_AT,
      },
      eventName
    );
  }

  // Cursor's camelCase event names never wake a PascalCase harness and
  // vice versa.
  assert.equal(
    buildCommandHookEnsureCapture(
      { hook_event_name: 'beforeSubmitPrompt', session_id: 'codex-session' },
      'codex',
      {}
    ),
    undefined
  );
});

test('cursor wakes on camelCase events with cursor payload identity', () => {
  for (const eventName of ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']) {
    assert.deepEqual(
      buildCommandHookEnsureCapture(
        {
          hook_event_name: eventName,
          session_id: 'cursor/conversation-id',
          conversation_id: 'cursor/conversation-id',
          workspace_roots: ['/workspace/repo with spaces'],
          prompt: 'must-never-leave-the-transcript',
          text: 'must-never-leave-the-transcript',
        },
        'cursor',
        {},
        () => HOOK_FIRED_AT
      ),
      {
        agentType: 'cursor',
        agentSessionId: 'cursor/conversation-id',
        cwd: '/workspace/repo with spaces',
        transcriptPath: undefined,
        observedAt: HOOK_FIRED_AT,
      },
      eventName
    );
  }

  // conversation_id keeps the wake working if session_id disappears.
  assert.equal(
    buildCommandHookEnsureCapture(
      { hook_event_name: 'stop', conversation_id: 'cursor/only-conversation' },
      'cursor',
      {}
    ).agentSessionId,
    'cursor/only-conversation'
  );

  assert.equal(
    buildCommandHookEnsureCapture(
      { hook_event_name: 'Stop', session_id: 'cursor-session' },
      'cursor',
      {}
    ),
    undefined
  );
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
    POLYGRAPH_CLI: '/workspace/dist/bin/polygraph',
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
      now: () => HOOK_FIRED_AT,
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
    ...OBSERVED_AT_ARGS,
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
    observedAt: HOOK_FIRED_AT,
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
  assert.equal(invocations[0].args.includes('--source'), false);
  assert.deepEqual(invocations[0].args.slice(-2), OBSERVED_AT_ARGS);
  assert.equal(invocations[1].args[0], '_link-agent-session');
  assert.equal(invocations[1].args.includes('--observed-at'), false);
  // The legacy mapping command keeps mutable mapping evidence and provenance.
  assert.deepEqual(invocations[1].args.slice(1, -2), [
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
    '--cwd',
    '/workspace/repo',
  ]);
  assert.deepEqual(invocations[1].args.slice(-2), ['--source', 'hook']);
  assert.equal(invocations[0].options.timeout, 4_900);
  assert.equal(invocations[1].options.timeout, 300);
  assert.equal(invocations[0].options.killSignal, 'SIGKILL');
  assert.equal(invocations[1].options.killSignal, 'SIGKILL');
});

test('the observed Shell 0.1.x usage response triggers one compatibility fallback without logging', () => {
  const invocations = [];
  const failures = [];

  assert.equal(
    main({
      agentType: 'claude',
      env: { POLYGRAPH_CLI: '/opt/polygraph' },
      payload: {
        hook_event_name: 'Stop',
        session_id: 'claude-session',
        cwd: '/workspace/repo',
        transcript_path: '/tmp/transcript.jsonl',
      },
      spawn(command, args, options) {
        invocations.push({ command, args, options });
        return invocations.length === 1
          ? { status: 1, stdout: OLD_CLI_UNSUPPORTED_STDOUT, stderr: '' }
          : { status: 0, stdout: '', stderr: '' };
      },
      logFailure(...failure) {
        failures.push(failure);
      },
      now: () => HOOK_FIRED_AT,
    }),
    true
  );

  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].args, [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
    ...OBSERVED_AT_ARGS,
  ]);
  assert.deepEqual(invocations[1].args, [
    '_link-agent-session',
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
  assert.deepEqual(failures, []);
});

test('arbitrary CLI failures that mention the hidden command never trigger fallback', () => {
  for (const result of [
    {
      status: 1,
      stdout: 'request failed for _ensure-agent-session-capture: unavailable',
      stderr: '',
    },
    {
      status: 1,
      stdout: OLD_CLI_UNSUPPORTED_STDOUT,
      stderr: 'runtime failed after parsing',
    },
    {
      status: 2,
      stdout: OLD_CLI_UNSUPPORTED_STDOUT,
      stderr: '',
    },
  ]) {
    let spawnCount = 0;
    assert.throws(
      () =>
        ensureAgentSessionCapture(
          { agentType: 'claude', agentSessionId: 'claude-session', observedAt: HOOK_FIRED_AT },
          () => {
            spawnCount += 1;
            return result;
          },
          {}
        ),
      /_ensure-agent-session-capture/
    );
    assert.equal(spawnCount, 1);
  }
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
          observedAt: HOOK_FIRED_AT,
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

test('a JS CLI entry wakes through Node up front, in exactly one process', () => {
  const invocations = [];
  const claim = {
    agentType: 'claude',
    agentSessionId: 'claude-session',
    cwd: '/workspace/repo',
    observedAt: HOOK_FIRED_AT,
  };

  assert.equal(
    ensureAgentSessionCapture(
      claim,
      (command, args, options) => {
        invocations.push({ command, args, options });
        return { status: 0, stderr: '' };
      },
      { POLYGRAPH_CLI: '/opt/polygraph.mjs' },
      { execPath: '/runtime/node', now: () => 10 }
    ),
    true
  );

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].command, '/runtime/node');
  assert.equal(invocations[0].args[0], '/opt/polygraph.mjs');
  assert.equal(invocations[0].args[1], '_ensure-agent-session-capture');
});

test('a spawn that throws launch errors synchronously (Bun) is contained after one attempt', () => {
  const thrown = Object.assign(new Error('spawnSync EACCES'), { code: 'EACCES' });
  let spawnCount = 0;

  assert.throws(
    () =>
      ensureAgentSessionCapture(
        { agentType: 'opencode', agentSessionId: 'opencode-root', observedAt: HOOK_FIRED_AT },
        () => {
          spawnCount += 1;
          throw thrown;
        },
        { POLYGRAPH_CLI: '/workspace/node_modules/.bin/polygraph' }
      ),
    thrown
  );
  assert.equal(spawnCount, 1);
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
    observedAt: HOOK_FIRED_AT,
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

test('a detached wake hands the claim to a worker and observes launch errors only', () => {
  let invocation;
  let unrefCount = 0;
  const logEvents = [];
  const listeners = {};
  const env = {
    POLYGRAPH_CLI: '/workspace/dist/bin/polygraph.js',
    POLYGRAPH_SESSION_ID: 'ambient-session',
    POLYGRAPH_CAPTURE_TOKEN: 'ambient-token',
  };

  assert.equal(
    main({
      agentType: 'codex',
      detach: true,
      env,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'codex-session',
        cwd: '/workspace/repo with spaces',
        transcript_path: '/tmp/rollout exact.jsonl',
      },
      spawn(command, args, options) {
        invocation = { command, args, options };
        logEvents.push('spawn');
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
      now: () => HOOK_FIRED_AT,
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
  assert.match(invocation.args[0], /ensure-agent-session-capture-worker\.mjs$/);
  assert.deepEqual(JSON.parse(invocation.args[1]), {
    agentType: 'codex',
    agentSessionId: 'codex-session',
    cwd: '/workspace/repo with spaces',
    transcriptPath: '/tmp/rollout exact.jsonl',
    observedAt: HOOK_FIRED_AT,
  });
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_SESSION_ID'), false);
  assert.equal(Object.hasOwn(invocation.options.env, 'POLYGRAPH_CAPTURE_TOKEN'), false);
  assert.equal(invocation.options.detached, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.cwd, '/workspace/repo with spaces');
  assert.deepEqual(invocation.options.stdio, ['ignore', 42, 42]);
  assert.equal(unrefCount, 1);
  assert.deepEqual(logEvents, ['open', 'spawn', ['close', 42]]);
  // CLI exit handling belongs to the worker; the short-lived hook registers
  // no exit listener.
  assert.deepEqual(Object.keys(listeners), ['error']);
});

test('a detached wake reports worker launch failures best-effort', () => {
  const listeners = {};
  const failures = [];

  assert.equal(
    main({
      agentType: 'cursor',
      detach: true,
      env: {},
      payload: {
        hook_event_name: 'beforeSubmitPrompt',
        conversation_id: 'cursor-session',
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
    }),
    true
  );

  const spawnError = new Error('spawn failed');
  listeners.error(spawnError);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].hook, 'cursor:ensure-agent-session-capture');
  assert.equal(failures[0].error, spawnError);
  assert.deepEqual(failures[0].meta, {
    hookEventName: 'beforeSubmitPrompt',
    agentSessionId: undefined,
  });
});

test('a detached wake launches the worker through a Node runtime, never the host binary', () => {
  // OpenCode hosts the plugin inside a compiled Bun binary, so process.execPath
  // there is not a Node executable.
  for (const [execPath, expected] of [
    ['/opt/homebrew/bin/opencode', 'node'],
    ['/usr/local/bin/bun', 'node'],
    ['/usr/local/bin/node', '/usr/local/bin/node'],
  ]) {
    let invocation;
    assert.equal(
      launchAgentSessionCaptureWake(
        { agentType: 'opencode', agentSessionId: 'ses_root', cwd: '/workspace/repo' },
        (command, args, options) => {
          invocation = { command, args, options };
          return { once() { return this; }, unref() {} };
        },
        {},
        { execPath, openLog: () => 1, closeLog: () => {} }
      ),
      true
    );
    assert.equal(invocation.command, expected, execPath);
    assert.match(invocation.args[0], /ensure-agent-session-capture-worker\.mjs$/);
    assert.deepEqual(JSON.parse(invocation.args[1]), {
      agentType: 'opencode',
      agentSessionId: 'ses_root',
      cwd: '/workspace/repo',
    });
    assert.equal(invocation.options.detached, true);
  }
});

test('cursor prompt and agent-done wakes never carry a PID, detached or inline', () => {
  const hookRunnerPid = String(process.ppid);

  for (const eventName of ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']) {
    const payload = {
      hook_event_name: eventName,
      session_id: 'cursor/conversation-id',
      conversation_id: 'cursor/conversation-id',
      workspace_roots: ['/workspace/repo'],
      transcript_path: '/tmp/cursor transcript.jsonl',
    };

    // Detached (the shipped manifest): the worker claim is identity plus the
    // mapping evidence the legacy fallback may need, and nothing else.
    let workerLaunch;
    assert.equal(
      main({
        agentType: 'cursor',
        detach: true,
        env: {},
        payload,
        spawn(command, args, options) {
          workerLaunch = { command, args, options };
          return { once() { return this; }, unref() {} };
        },
        launcherOptions: { openLog: () => 1, closeLog: () => {} },
        now: () => HOOK_FIRED_AT,
      }),
      true,
      eventName
    );
    assert.deepEqual(JSON.parse(workerLaunch.args[1]), {
      agentType: 'cursor',
      agentSessionId: 'cursor/conversation-id',
      cwd: '/workspace/repo',
      transcriptPath: '/tmp/cursor transcript.jsonl',
      observedAt: HOOK_FIRED_AT,
    });

    // Inline, through the old-CLI compatibility fallback: neither the ensure
    // command nor the legacy mapping command binds a PID.
    const invocations = [];
    assert.equal(
      main({
        agentType: 'cursor',
        detach: false,
        env: { POLYGRAPH_CLI: '/opt/polygraph' },
        payload,
        spawn(command, args, options) {
          invocations.push({ command, args, options });
          return invocations.length === 1
            ? { status: 1, stdout: OLD_CLI_UNSUPPORTED_STDOUT, stderr: '' }
            : { status: 0, stdout: '', stderr: '' };
        },
      }),
      true,
      eventName
    );
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].args[0], '_ensure-agent-session-capture');
    assert.equal(invocations[0].args.includes('--observed-at'), true, eventName);
    assert.equal(invocations[1].args[0], '_link-agent-session');
    assert.equal(invocations[1].args.includes('--observed-at'), false, eventName);
    for (const { args } of invocations) {
      assert.equal(args.includes('--pid'), false, eventName);
      assert.equal(args.includes(hookRunnerPid), false, eventName);
    }
  }
});

test('managed children never launch a detached wake worker', () => {
  let spawnCount = 0;
  assert.equal(
    main({
      agentType: 'codex',
      detach: true,
      env: { POLYGRAPH_CHILD_AGENT: '' },
      payload: { hook_event_name: 'Stop', session_id: 'codex-child' },
      spawn() {
        spawnCount += 1;
        return { once() { return this; }, unref() {} };
      },
      launcherOptions: { openLog: () => 1, closeLog: () => {} },
    }),
    false
  );
  assert.equal(spawnCount, 0);
});
