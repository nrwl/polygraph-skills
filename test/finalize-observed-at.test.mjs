import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookEnsureCapture,
  buildEnsureAgentSessionCaptureArgs,
} from '../source/hooks/agent-session-capture.mjs';
import {
  buildCommandHookFinalize,
  buildFinalizeAgentSessionArgs,
} from '../source/hooks/agent-session-finalize.mjs';
import { main as finalizeHookMain } from '../source/hooks/finalize-agent-session.mjs';
import { main as finalizeWorkerMain } from '../source/hooks/finalize-agent-session-worker.mjs';

const hooksDir = fileURLToPath(new URL('../source/hooks/', import.meta.url));

// The ordering Ocean relies on: a harness exit observed at T1, a wake or
// relink of the same identity observed at T2 > T1, and the finalize worker
// only reaching the CLI at T3 > T2 (it may take up to 90 seconds). Ocean
// ignores a finalize whose observation predates the mapping's last-seen
// time, which only works if the finalize reports T1 — never T3.
const EXIT_OBSERVED_AT = 1_767_225_600_000;
const LATER_WAKE_OBSERVED_AT = EXIT_OBSERVED_AT + 3_000;
const WORKER_RAN_AT = EXIT_OBSERVED_AT + 45_000;

function fakeChild() {
  return {
    once() {
      return this;
    },
    unref() {},
  };
}

// The suite may itself run inside a managed Polygraph agent.
function hookEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.POLYGRAPH_CHILD_AGENT;
  delete env.POLYGRAPH_SESSION_ID;
  delete env.POLYGRAPH_CAPTURE_TOKEN;
  return env;
}

const FINALIZE_PAYLOADS = {
  claude: {
    hook_event_name: 'SessionEnd',
    session_id: 'claude-session',
    cwd: '/workspace/repo',
    transcript_path: '/tmp/transcript.jsonl',
    reason: 'other',
  },
  cursor: {
    hook_event_name: 'sessionEnd',
    session_id: 'cursor/conversation-id',
    conversation_id: 'cursor/conversation-id',
    workspace_roots: ['/workspace/repo'],
    reason: 'user_close',
    final_status: 'completed',
  },
};

test('the finalize claim is stamped in the hook process before the worker detaches', () => {
  for (const [agentType, payload] of Object.entries(FINALIZE_PAYLOADS)) {
    const clock = [EXIT_OBSERVED_AT, WORKER_RAN_AT];
    let launch;
    assert.equal(
      finalizeHookMain({
        agentType,
        env: {},
        payload,
        spawn(command, args, options) {
          launch = { command, args, options };
          return fakeChild();
        },
        launcherOptions: { openLog: () => 1, closeLog: () => {} },
        now: () => clock.shift(),
      }),
      true,
      agentType
    );
    const claim = JSON.parse(launch.args[1]);
    assert.equal(claim.observedAt, EXIT_OBSERVED_AT, agentType);
    // The hook read its clock exactly once, when the claim was built.
    assert.deepEqual(clock, [WORKER_RAN_AT], agentType);

    // The worker forwards the serialized observation verbatim; its own clock
    // never enters the argv.
    let invocation;
    assert.equal(
      finalizeWorkerMain({
        serializedClaim: launch.args[1],
        env: { POLYGRAPH_CLI: '/opt/polygraph' },
        spawn(command, args, options) {
          invocation = { command, args, options };
          return { status: 0, stdout: '', stderr: '' };
        },
        logFailure() {
          throw new Error('success must not log a failure');
        },
        writeFailure() {
          throw new Error('success must not write a failure');
        },
      }),
      true,
      agentType
    );
    assert.deepEqual(
      invocation.args.slice(-4),
      ['--source', 'hook', '--observed-at', String(EXIT_OBSERVED_AT)],
      agentType
    );
    assert.equal(invocation.args.includes(String(WORKER_RAN_AT)), false, agentType);
  }
});

test('a finalize delayed past a later wake still reports the exit observation, so Ocean can ignore it', () => {
  const finalizeClaim = buildCommandHookFinalize(
    FINALIZE_PAYLOADS.claude,
    'claude',
    {},
    () => EXIT_OBSERVED_AT
  );
  const wakeClaim = buildCommandHookEnsureCapture(
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      cwd: '/workspace/repo',
      prompt: 'resumed after the exit',
    },
    'claude',
    {},
    () => LATER_WAKE_OBSERVED_AT
  );

  const finalizeArgs = buildFinalizeAgentSessionArgs(finalizeClaim);
  const wakeArgs = buildEnsureAgentSessionCaptureArgs(wakeClaim);
  const observed = (args) => Number(args[args.indexOf('--observed-at') + 1]);

  // Same identity, and the observations order like the hooks that fired
  // them, whatever order the CLI processes land in.
  assert.deepEqual(finalizeArgs.slice(1, 5), wakeArgs.slice(1, 5));
  assert.ok(observed(finalizeArgs) < observed(wakeArgs));
  assert.equal(observed(finalizeArgs), EXIT_OBSERVED_AT);
});

test('buildFinalizeAgentSessionArgs refuses a claim without a hook-captured observation time', () => {
  for (const observedAt of [undefined, null, 0, -1, 1.5, NaN, String(EXIT_OBSERVED_AT)]) {
    assert.throws(
      () =>
        buildFinalizeAgentSessionArgs({
          agentType: 'claude',
          agentSessionId: 'claude-session',
          source: 'hook',
          observedAt,
        }),
      /observedAt is required/,
      String(observedAt)
    );
  }
});

// The shipped hooks, run as the harness runs them: the CLI receives an
// observation bounded by the hook process's own lifetime even though it only
// runs later, in the detached worker.
for (const [agentType, payload] of Object.entries(FINALIZE_PAYLOADS)) {
  test(`shipped finalize hook for ${agentType} reports the hook-fired time, not the worker's`, () => {
    const home = mkdtempSync(join(tmpdir(), 'pg finalize observed-'));
    try {
      const marker = join(home, 'cli-invocation.json');
      const cliPath = join(home, 'polygraph cli.js');
      writeFileSync(
        cliPath,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), ranAt: Date.now() }));\nprocess.exit(0);\n`
      );

      const hookStartedAfter = Date.now();
      const hook = spawnSync(
        process.execPath,
        [join(hooksDir, 'finalize-agent-session.mjs'), agentType],
        {
          cwd: hooksDir,
          encoding: 'utf8',
          input: JSON.stringify(payload),
          env: hookEnv({ HOME: home, POLYGRAPH_CLI: cliPath }),
        }
      );
      const hookExitedBefore = Date.now();
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stdout, '');

      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      assert.equal(existsSync(marker), true, 'detached worker never reached the CLI');
      const { argv, ranAt } = JSON.parse(readFileSync(marker, 'utf8'));
      const observedAt = Number(argv[argv.indexOf('--observed-at') + 1]);
      assert.ok(
        observedAt >= hookStartedAfter && observedAt <= hookExitedBefore,
        `${observedAt} outside the hook's lifetime [${hookStartedAfter}, ${hookExitedBefore}]`
      );
      assert.ok(ranAt >= observedAt);
      assert.deepEqual(argv.slice(-4), ['--source', 'hook', '--observed-at', String(observedAt)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
