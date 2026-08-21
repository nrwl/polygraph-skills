import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  buildCommandHookEnsureCapture,
  buildEnsureAgentSessionCaptureArgs,
  ensureAgentSessionCapture,
} from '../source/hooks/agent-session-capture.mjs';
import { main } from '../source/hooks/ensure-agent-session-capture.mjs';

test('Claude registers an asynchronous Stop hook with a shipped command artifact', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../source/hooks/hooks.json', import.meta.url), 'utf8')
  );
  const stopHooks = manifest.hooks.Stop;

  assert.equal(stopHooks.length, 1);
  assert.equal(stopHooks[0].hooks.length, 1);

  const hook = stopHooks[0].hooks[0];
  assert.equal(hook.type, 'command');
  assert.equal(
    hook.command,
    'node ${CLAUDE_PLUGIN_ROOT}/hooks/ensure-agent-session-capture.mjs claude'
  );
  assert.equal(hook.async, true);
  assert.equal(
    existsSync(
      new URL('../source/hooks/ensure-agent-session-capture.mjs', import.meta.url)
    ),
    true
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
  });
  assert.deepEqual(buildEnsureAgentSessionCaptureArgs(claim), [
    '_ensure-agent-session-capture',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
  ]);
});

test('capture hook accepts only complete Claude Stop payloads', () => {
  const valid = { hook_event_name: 'Stop', session_id: 'claude-session' };

  for (const payload of [
    undefined,
    null,
    [],
    {},
    { session_id: 'claude-session' },
    { ...valid, hook_event_name: 'stop' },
    { ...valid, hook_event_name: 'SubagentStop' },
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
  ]);
  assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(Object.hasOwn(invocation.options, 'shell'), false);
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
