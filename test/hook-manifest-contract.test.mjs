import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildCommandHookEnsureCapture,
  buildEnsureAgentSessionCaptureArgs,
  buildLegacyCaptureWakeArgs,
} from '../source/hooks/agent-session-capture.mjs';
import {
  buildCommandHookFinalize,
  buildFinalizeAgentSessionArgs,
} from '../source/hooks/agent-session-finalize.mjs';

const sourceDir = resolve(import.meta.dirname, '..', 'source');
const HOOK_FIRED_AT = 1_767_225_600_000;

// One wake contract for every harness manifest: prompt-submit and agent-done
// register the same identity-only command, made non-blocking either by the
// manifest's own async flag or by the hook detaching itself.
const HARNESSES = {
  claude: {
    manifest: 'hooks/hooks.json',
    root: '${CLAUDE_PLUGIN_ROOT}/',
    wakeEvents: ['UserPromptSubmit', 'Stop'],
    manifestAsync: true,
  },
  codex: {
    manifest: 'codex/hooks/hooks.json',
    root: '${PLUGIN_ROOT}/',
    wakeEvents: ['UserPromptSubmit', 'Stop'],
    manifestAsync: false,
  },
  cursor: {
    manifest: 'cursor/hooks/hooks.json',
    root: '',
    wakeEvents: ['beforeSubmitPrompt', 'afterAgentResponse', 'stop'],
    manifestAsync: false,
  },
};

function readManifest(harness) {
  return JSON.parse(
    readFileSync(join(sourceDir, HARNESSES[harness].manifest), 'utf8')
  );
}

// Claude and Codex nest commands under matcher groups; Cursor registers
// commands directly. Both flatten to the same {command, async} shape.
function registrations(manifest, eventName) {
  const entries = manifest.hooks[eventName] ?? [];
  return entries.flatMap((entry) =>
    entry.hooks
      ? entry.hooks.map((hook) => ({ command: hook.command, async: hook.async }))
      : [{ command: entry.command, async: entry.async }]
  );
}

function allRegistrations(manifest) {
  return Object.keys(manifest.hooks).flatMap((eventName) =>
    registrations(manifest, eventName).map((hook) => ({ eventName, ...hook }))
  );
}

test('every harness registers one identical non-blocking wake for prompt-submit and agent-done', () => {
  for (const [harness, spec] of Object.entries(HARNESSES)) {
    const manifest = readManifest(harness);
    const expected =
      `node ${spec.root}hooks/ensure-agent-session-capture.mjs ${harness}` +
      (spec.manifestAsync ? '' : ' --detach');

    for (const eventName of spec.wakeEvents) {
      const hooks = registrations(manifest, eventName);
      assert.equal(hooks.length, 1, `${harness} ${eventName}`);
      assert.equal(hooks[0].command, expected, `${harness} ${eventName}`);
      assert.equal(
        hooks[0].async,
        spec.manifestAsync ? true : undefined,
        `${harness} ${eventName}`
      );
      // The command never encodes which event fired or any provenance.
      assert.doesNotMatch(
        hooks[0].command,
        /--source|prompt|response|stop|idle/i
      );
    }
  }
});

test('every manifest hook command names a script shipped from source/hooks', () => {
  for (const [harness, spec] of Object.entries(HARNESSES)) {
    for (const { eventName, command } of allRegistrations(readManifest(harness))) {
      const script = command.match(/^node (\S*)hooks\/([^\s]+\.mjs)\b/);
      assert.ok(script, `${harness} ${eventName}: ${command}`);
      assert.equal(script[1], spec.root, `${harness} ${eventName}: ${command}`);
      assert.equal(
        existsSync(join(sourceDir, 'hooks', script[2])),
        true,
        `${harness} ${eventName} references missing ${script[2]}`
      );
    }
  }
});

// Claude's documented SessionStart sources. Every one links the session under
// its (possibly new) id so a cleared or forked conversation is captured too.
const CLAUDE_SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'];

test('Claude SessionStart links and re-injects context for every documented source', () => {
  const manifest = readManifest('claude');
  const entries = manifest.hooks.SessionStart;
  assert.equal(entries.length, 1);

  const sources = entries[0].matcher.split('|');
  assert.deepEqual([...sources].sort(), [...CLAUDE_SESSION_START_SOURCES].sort());

  const commands = entries[0].hooks.map((hook) => hook.command);
  assert.deepEqual(commands, [
    'node ${CLAUDE_PLUGIN_ROOT}/hooks/reinject-polygraph-context.mjs',
    'node ${CLAUDE_PLUGIN_ROOT}/hooks/record-session-mapping.mjs claude',
  ]);
});

test('cursor hook commands stay relative because cursor runs them from the plugin root', () => {
  for (const { command } of allRegistrations(readManifest('cursor'))) {
    assert.match(command, /^node hooks\//);
    assert.doesNotMatch(command, /\$\{|\/Users\/|\/home\//);
  }
});

test('Claude and Cursor register one detached-worker finalization each; Codex none', () => {
  const finalizers = [
    ['claude', 'SessionEnd', 'node ${CLAUDE_PLUGIN_ROOT}/hooks/finalize-agent-session.mjs claude'],
    ['cursor', 'sessionEnd', 'node hooks/finalize-agent-session.mjs cursor'],
  ];
  for (const [harness, eventName, command] of finalizers) {
    const manifest = readManifest(harness);
    const hooks = registrations(manifest, eventName);
    assert.equal(hooks.length, 1, harness);
    assert.equal(hooks[0].command, command, harness);
    // The hook itself returns as soon as the worker is detached, so it
    // needs no manifest async flag and never carries --detach.
    assert.equal(hooks[0].async, undefined, harness);
    assert.doesNotMatch(hooks[0].command, /--detach|--pid|--source/);
    // Exactly one casing per harness.
    const otherCasing = eventName === 'SessionEnd' ? 'sessionEnd' : 'SessionEnd';
    assert.equal(otherCasing in manifest.hooks, false, `${harness} ${otherCasing}`);
  }

  const codex = readManifest('codex');
  for (const eventName of ['SessionEnd', 'sessionEnd']) {
    assert.equal(eventName in codex.hooks, false, `codex ${eventName}`);
  }
});

// Representative payloads per harness. Everything beyond stable identity is
// present precisely so the tests can prove it never leaves the payload.
const WAKE_PAYLOADS = {
  claude: {
    UserPromptSubmit: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude/session id',
      cwd: '/workspace/claude repo',
      transcript_path: '/tmp/claude transcript.jsonl',
      prompt: 'secret prompt text',
      permission_mode: 'default',
    },
    Stop: {
      hook_event_name: 'Stop',
      session_id: 'claude/session id',
      cwd: '/workspace/claude repo',
      transcript_path: '/tmp/claude transcript.jsonl',
      stop_hook_active: false,
      last_assistant_message: 'secret answer text',
    },
  },
  codex: {
    UserPromptSubmit: {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex/thread id',
      cwd: '/workspace/codex repo',
      transcript_path: '/tmp/codex rollout.jsonl',
      prompt: 'secret prompt text',
    },
    Stop: {
      hook_event_name: 'Stop',
      session_id: 'codex/thread id',
      cwd: '/workspace/codex repo',
      transcript_path: '/tmp/codex rollout.jsonl',
      last_assistant_message: 'secret answer text',
    },
  },
  cursor: {
    beforeSubmitPrompt: {
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'cursor/conversation id',
      session_id: 'cursor/conversation id',
      generation_id: 'gen-1',
      workspace_roots: ['/workspace/cursor repo'],
      transcript_path: '/tmp/cursor transcript.jsonl',
      prompt: 'secret prompt text',
      attachments: [],
    },
    afterAgentResponse: {
      hook_event_name: 'afterAgentResponse',
      conversation_id: 'cursor/conversation id',
      session_id: 'cursor/conversation id',
      generation_id: 'gen-2',
      workspace_roots: ['/workspace/cursor repo'],
      transcript_path: '/tmp/cursor transcript.jsonl',
      text: 'secret answer text',
    },
    stop: {
      hook_event_name: 'stop',
      conversation_id: 'cursor/conversation id',
      session_id: 'cursor/conversation id',
      generation_id: 'gen-3',
      workspace_roots: ['/workspace/cursor repo'],
      transcript_path: '/tmp/cursor transcript.jsonl',
      status: 'completed',
      loop_count: 0,
    },
  },
};

test('prompt-submit and every agent-done payload reduce to one identical identity-only ensure invocation', () => {
  for (const [harness, spec] of Object.entries(HARNESSES)) {
    const argvByEvent = spec.wakeEvents.map((eventName) => {
      const payload = WAKE_PAYLOADS[harness][eventName];
      const claim = buildCommandHookEnsureCapture(
        payload,
        harness,
        {},
        () => HOOK_FIRED_AT
      );
      assert.ok(claim, `${harness} ${eventName}`);
      return buildEnsureAgentSessionCaptureArgs(claim);
    });

    for (const argv of argvByEvent.slice(1)) {
      assert.deepEqual(argv, argvByEvent[0], harness);
    }
    assert.deepEqual(argvByEvent[0], [
      '_ensure-agent-session-capture',
      '--agent-type',
      harness,
      '--agent-session-id',
      WAKE_PAYLOADS[harness][spec.wakeEvents[0]].session_id,
      '--observed-at',
      String(HOOK_FIRED_AT),
    ]);

    const joined = argvByEvent[0].join('\n');
    assert.doesNotMatch(
      joined,
      /secret|transcript|workspace|--cwd|--source|--pid|status/
    );
  }
});

test('the legacy mapping fallback keeps path evidence and provenance the ensure command drops', () => {
  for (const [harness, spec] of Object.entries(HARNESSES)) {
    for (const eventName of spec.wakeEvents) {
      const payload = WAKE_PAYLOADS[harness][eventName];
      const claim = buildCommandHookEnsureCapture(payload, harness, {}, () => HOOK_FIRED_AT);
      const cwd = payload.cwd ?? payload.workspace_roots[0];

      assert.deepEqual(buildLegacyCaptureWakeArgs(claim), [
        '_link-agent-session',
        '--agent-type',
        harness,
        '--agent-session-id',
        payload.session_id,
        '--cwd',
        cwd,
        '--transcript-path',
        payload.transcript_path,
        '--source',
        'hook',
      ]);
    }
  }
});

test('non-wake lifecycle events and foreign harness casing never build a wake claim', () => {
  const foreign = {
    claude: [
      'stop',
      'beforeSubmitPrompt',
      'SessionStart',
      'SessionEnd',
      'PostToolUse',
      'SubagentStop',
      'PreCompact',
    ],
    codex: ['stop', 'beforeSubmitPrompt', 'SessionStart', 'PostToolUse', 'SubagentStop'],
    cursor: [
      'Stop',
      'UserPromptSubmit',
      'sessionStart',
      'sessionEnd',
      'postToolUse',
      'afterAgentThought',
      'subagentStop',
    ],
  };

  for (const [harness, spec] of Object.entries(HARNESSES)) {
    const base = WAKE_PAYLOADS[harness][spec.wakeEvents[0]];
    for (const eventName of foreign[harness]) {
      assert.equal(
        buildCommandHookEnsureCapture(
          { ...base, hook_event_name: eventName },
          harness,
          {}
        ),
        undefined,
        `${harness} ${eventName}`
      );
    }
    // A managed child never wakes, whatever the event.
    assert.equal(
      buildCommandHookEnsureCapture(base, harness, { POLYGRAPH_CHILD_AGENT: '1' }),
      undefined,
      harness
    );
  }
});

const FINALIZE_PAYLOADS = {
  claude: {
    hook_event_name: 'SessionEnd',
    session_id: 'claude/session id',
    cwd: '/workspace/claude repo',
    transcript_path: '/tmp/claude transcript.jsonl',
    reason: 'exit',
  },
  cursor: {
    hook_event_name: 'sessionEnd',
    conversation_id: 'cursor/session id',
    session_id: 'cursor/session id',
    generation_id: 'gen-9',
    workspace_roots: ['/workspace/cursor repo'],
    transcript_path: '/tmp/cursor transcript.jsonl',
    reason: 'user_close',
    final_status: 'completed',
    duration_ms: 1234,
  },
};

test('finalization payloads keep identity, paths, and provenance and drop everything else', () => {
  for (const [harness, payload] of Object.entries(FINALIZE_PAYLOADS)) {
    const claim = buildCommandHookFinalize(payload, harness, {}, () => HOOK_FIRED_AT);
    const args = buildFinalizeAgentSessionArgs(claim);
    assert.deepEqual(args, [
      '_finalize-agent-session',
      '--agent-type',
      harness,
      '--agent-session-id',
      payload.session_id,
      '--cwd',
      payload.cwd ?? payload.workspace_roots[0],
      '--transcript-path',
      payload.transcript_path,
      '--source',
      'hook',
      '--observed-at',
      String(HOOK_FIRED_AT),
    ], harness);
    assert.doesNotMatch(args.join('\n'), /--pid|reason|status|exit|completed/);

    // The wrong casing, another harness, or a wake event never finalizes.
    const otherCasing =
      payload.hook_event_name === 'SessionEnd' ? 'sessionEnd' : 'SessionEnd';
    assert.equal(
      buildCommandHookFinalize({ ...payload, hook_event_name: otherCasing }, harness, {}),
      undefined,
      `${harness} ${otherCasing}`
    );
    for (const other of ['claude', 'codex', 'cursor', 'opencode'].filter((h) => h !== harness)) {
      assert.equal(buildCommandHookFinalize(payload, other, {}), undefined, `${harness}->${other}`);
    }
    for (const eventName of ['Stop', 'stop', 'afterAgentResponse', 'UserPromptSubmit']) {
      assert.equal(
        buildCommandHookFinalize({ ...payload, hook_event_name: eventName }, harness, {}),
        undefined,
        `${harness} ${eventName}`
      );
    }
  }

  for (const harness of ['codex', 'opencode']) {
    assert.throws(
      () =>
        buildFinalizeAgentSessionArgs({
          agentType: harness,
          agentSessionId: 'x',
          source: 'hook',
        }),
      /Unsupported agent type/
    );
  }
});

test('finalization carries the hook-fired observation time exactly as a wake does', () => {
  for (const [harness, payload] of Object.entries(FINALIZE_PAYLOADS)) {
    const claim = buildCommandHookFinalize(payload, harness, {}, () => HOOK_FIRED_AT);
    assert.equal(claim.observedAt, HOOK_FIRED_AT, harness);
    assert.deepEqual(
      buildFinalizeAgentSessionArgs(claim).slice(-4),
      ['--source', 'hook', '--observed-at', String(HOOK_FIRED_AT)],
      harness
    );
    // A finalize without the hook's own clock reading never reaches the CLI;
    // nothing guesses one, least of all a delayed worker.
    for (const observedAt of [undefined, null, 0, -1, 1.5, NaN, String(HOOK_FIRED_AT)]) {
      assert.throws(
        () => buildFinalizeAgentSessionArgs({ ...claim, observedAt }),
        /observedAt is required/,
        `${harness} ${String(observedAt)}`
      );
    }
  }
});

// Cursor's hook process runs from the plugin root, so a payload without
// workspace roots yields a claim with no directory: neither the legacy
// mapping fallback nor the finalize may record any --cwd for it.
test('a cursor payload without workspace roots records no directory on any command', () => {
  for (const roots of [undefined, [], [''], ['   ']]) {
    const label = JSON.stringify(roots);
    for (const eventName of HARNESSES.cursor.wakeEvents) {
      const claim = buildCommandHookEnsureCapture(
        { ...WAKE_PAYLOADS.cursor[eventName], workspace_roots: roots },
        'cursor',
        {},
        () => HOOK_FIRED_AT
      );
      assert.equal(claim.cwd, undefined, `${eventName} ${label}`);
      assert.equal(buildLegacyCaptureWakeArgs(claim).includes('--cwd'), false, `${eventName} ${label}`);
    }
    const finalize = buildCommandHookFinalize(
      { ...FINALIZE_PAYLOADS.cursor, workspace_roots: roots },
      'cursor',
      {},
      () => HOOK_FIRED_AT
    );
    assert.equal(finalize.cwd, undefined, label);
    assert.equal(buildFinalizeAgentSessionArgs(finalize).includes('--cwd'), false, label);
  }
});
