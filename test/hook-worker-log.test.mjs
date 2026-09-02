import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOOK_WORKER_LOG_MAX_BYTES,
  launchDetachedHookWorker,
  openHookWorkerLog,
} from '../source/hooks/capture-cli.mjs';
import { launchAgentSessionCaptureWake } from '../source/hooks/agent-session-capture.mjs';
import { launchAgentSessionFinalize } from '../source/hooks/agent-session-finalize.mjs';

const hooksDir = fileURLToPath(new URL('../source/hooks/', import.meta.url));

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

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pg worker log-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function seedLog(home, logName, size) {
  const logsDir = join(home, '.polygraph', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, logName);
  const fd = openSync(logFile, 'w');
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
  return logFile;
}

for (const logName of ['capture-wake.log', 'session-finalize.log']) {
  test(`${logName} rotates to .1 once it passes the hooks.log bound`, () => {
    withHome((home) => {
      const logFile = seedLog(home, logName, HOOK_WORKER_LOG_MAX_BYTES + 1);

      closeSync(openHookWorkerLog({ HOME: home }, logName));

      assert.equal(statSync(`${logFile}.1`).size, HOOK_WORKER_LOG_MAX_BYTES + 1);
      assert.equal(statSync(logFile).size, 0);
      assert.equal(statSync(logFile).mode & 0o777, 0o600);
    });
  });

  test(`${logName} within the bound is appended to, not rotated`, () => {
    withHome((home) => {
      const logFile = seedLog(home, logName, HOOK_WORKER_LOG_MAX_BYTES);

      closeSync(openHookWorkerLog({ HOME: home }, logName));

      assert.equal(existsSync(`${logFile}.1`), false);
      assert.equal(statSync(logFile).size, HOOK_WORKER_LOG_MAX_BYTES);
    });
  });
}

test('the default wake and finalize launchers open their own bounded logs', () => {
  withHome((home) => {
    const wakeLog = seedLog(home, 'capture-wake.log', HOOK_WORKER_LOG_MAX_BYTES + 1);
    const finalizeLog = seedLog(home, 'session-finalize.log', HOOK_WORKER_LOG_MAX_BYTES + 1);
    const launches = [];
    const spawn = (command, args, options) => {
      launches.push({ command, args, options });
      return fakeChild();
    };
    const env = { HOME: home };

    assert.equal(
      launchAgentSessionCaptureWake(
        { agentType: 'cursor', agentSessionId: 'cursor-session', cwd: home },
        spawn,
        env
      ),
      true
    );
    assert.equal(
      launchAgentSessionFinalize(
        { agentType: 'cursor', agentSessionId: 'cursor-session', cwd: home, source: 'hook' },
        spawn,
        env
      ),
      true
    );

    assert.equal(launches.length, 2);
    for (const { options } of launches) {
      assert.equal(typeof options.stdio[1], 'number');
      assert.equal(options.stdio[1], options.stdio[2]);
    }
    assert.equal(existsSync(`${wakeLog}.1`), true);
    assert.equal(existsSync(`${finalizeLog}.1`), true);
    assert.equal(statSync(wakeLog).size, 0);
    assert.equal(statSync(finalizeLog).size, 0);
  });
});

test('a worker still launches with discarded output when its log cannot be opened', () => {
  const failures = [];
  let invocation;
  let closed = 0;
  const openError = Object.assign(new Error('EACCES: permission denied'), {
    code: 'EACCES',
  });

  assert.equal(
    launchDetachedHookWorker({
      workerPath: join(hooksDir, 'ensure-agent-session-capture-worker.mjs'),
      claim: { agentType: 'cursor', agentSessionId: 'cursor-session', cwd: '/workspace/repo' },
      logName: 'capture-wake.log',
      env: {},
      spawn(command, args, options) {
        invocation = { command, args, options };
        return fakeChild();
      },
      openLog() {
        throw openError;
      },
      closeLog() {
        closed += 1;
      },
      onFailure(error) {
        failures.push(error);
      },
    }),
    true
  );

  assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'ignore']);
  assert.equal(invocation.options.detached, true);
  assert.match(invocation.args[0], /ensure-agent-session-capture-worker\.mjs$/);
  assert.deepEqual(failures, [openError]);
  assert.equal(closed, 0);
});

test('an unwritable home degrades the real log open to discarded output', () => {
  withHome((home) => {
    // HOME is a regular file, so ~/.polygraph/logs can never be created.
    const fileAsHome = join(home, 'not a directory');
    writeFileSync(fileAsHome, '');
    const failures = [];
    let invocation;

    assert.equal(
      launchAgentSessionFinalize(
        { agentType: 'cursor', agentSessionId: 'cursor-session', cwd: home, source: 'hook' },
        (command, args, options) => {
          invocation = { command, args, options };
          return fakeChild();
        },
        { HOME: fileAsHome },
        { onFailure: (error) => failures.push(error) }
      ),
      true
    );

    assert.deepEqual(invocation.options.stdio, ['ignore', 'ignore', 'ignore']);
    assert.equal(failures.length, 1);
    assert.match(failures[0].code ?? failures[0].message, /ENOTDIR|EEXIST|ENOENT|EACCES/);
  });
});

// The shipped Cursor hooks, run exactly as cursor-agent runs them (cwd at the
// plugin root, payload on stdin): silent on stdout, prompt exit, and the
// detached worker still reaches the CLI even when the worker log is unusable.
for (const [script, payload, expectedCommand] of [
  [
    'ensure-agent-session-capture.mjs cursor --detach',
    {
      hook_event_name: 'afterAgentResponse',
      conversation_id: 'cursor/conversation-id',
      session_id: 'cursor/conversation-id',
      workspace_roots: [],
      text: 'answer text that stays in the transcript',
    },
    '_ensure-agent-session-capture',
  ],
  [
    'finalize-agent-session.mjs cursor',
    {
      hook_event_name: 'sessionEnd',
      conversation_id: 'cursor/conversation-id',
      session_id: 'cursor/conversation-id',
      workspace_roots: [],
      reason: 'user_close',
      final_status: 'completed',
    },
    '_finalize-agent-session',
  ],
]) {
  test(`hook "${script}" stays stdout-silent with an unusable worker log`, () => {
    withHome((home) => {
      const fileAsHome = join(home, 'not a directory');
      writeFileSync(fileAsHome, '');
      const marker = join(home, 'cli-argv.json');
      const cliPath = join(home, 'polygraph cli.js');
      writeFileSync(
        cliPath,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`
      );
      const [file, ...args] = script.split(' ');
      const hookFiredAfter = Date.now();

      const hook = spawnSync(process.execPath, [join(hooksDir, file), ...args], {
        cwd: hooksDir,
        encoding: 'utf8',
        input: JSON.stringify({ ...payload, workspace_roots: [home] }),
        env: hookEnv({ HOME: fileAsHome, POLYGRAPH_CLI: cliPath }),
      });

      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stdout, '');

      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      assert.equal(existsSync(marker), true, 'detached worker never reached the CLI');
      const argv = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(argv[0], expectedCommand);
      assert.deepEqual(argv.slice(1, 5), [
        '--agent-type',
        'cursor',
        '--agent-session-id',
        'cursor/conversation-id',
      ]);
      assert.equal(argv.includes('--pid'), false);
      assert.equal(argv.includes('answer text that stays in the transcript'), false);
      // Only the ensure wake carries the hook-captured observation time.
      const observedAtIndex = argv.indexOf('--observed-at');
      if (expectedCommand === '_ensure-agent-session-capture') {
        assert.notEqual(observedAtIndex, -1);
        const observedAt = Number(argv[observedAtIndex + 1]);
        assert.ok(observedAt >= hookFiredAfter && observedAt <= Date.now());
      } else {
        assert.equal(observedAtIndex, -1);
      }
    });
  });
}
