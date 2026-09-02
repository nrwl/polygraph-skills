import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  processWorkingDirectory,
  resolveLaunchDirectory,
} from '../source/hooks/capture-cli.mjs';
import {
  ensureAgentSessionCapture,
  launchAgentSessionCaptureWake,
} from '../source/hooks/agent-session-capture.mjs';
import {
  finalizeAgentSession,
  launchAgentSessionFinalize,
} from '../source/hooks/agent-session-finalize.mjs';

const hooksDir = fileURLToPath(new URL('../source/hooks/', import.meta.url));
const HOOK_FIRED_AT = 1_767_225_600_000;

// The observed Shell 0.1.x response to the hidden ensure command.
const OLD_CLI_UNSUPPORTED_STDOUT =
  'Usage: polygraph\nPolygraph CLI for cross-repo coordination\n\n' +
  'Validation failed for one or more options\n' +
  '  - Unknown argument: _ensure-agent-session-capture\n';

function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pg launch dir-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// A harness working directory that existed when the claim was built and is
// gone by the time the launch happens (an archived session worktree).
function vanishedDirectory(home) {
  const directory = join(home, 'archived session worktree');
  mkdirSync(directory);
  rmSync(directory, { recursive: true, force: true });
  assert.equal(existsSync(directory), false);
  return directory;
}

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

test('resolveLaunchDirectory keeps an existing claim directory and falls back to home, then temp', () => {
  withHome((home) => {
    const repo = join(home, 'repo with spaces');
    mkdirSync(repo);
    assert.equal(resolveLaunchDirectory(repo, { HOME: home }), repo);

    const gone = vanishedDirectory(home);
    assert.equal(resolveLaunchDirectory(gone, { HOME: home }), home);
    assert.equal(resolveLaunchDirectory(undefined, { HOME: home }), home);
    assert.equal(resolveLaunchDirectory('   ', { HOME: home }), home);

    // A file is not a launch directory either.
    const file = join(home, 'not a directory');
    writeFileSync(file, '');
    assert.equal(resolveLaunchDirectory(file, { HOME: home }), home);

    // An unusable HOME falls through to the temp directory; no HOME at all
    // means the OS home directory.
    assert.equal(resolveLaunchDirectory(gone, { HOME: file }), tmpdir());
    assert.equal(
      resolveLaunchDirectory(gone, { HOME: join(home, 'missing home') }),
      tmpdir()
    );
    assert.equal(resolveLaunchDirectory(gone, {}), homedir());
  });
});

test('a detached worker launches from the home directory while its claim keeps the vanished cwd', () => {
  withHome((home) => {
    const gone = vanishedDirectory(home);
    const launches = [];
    const spawn = (command, args, options) => {
      launches.push({ command, args, options });
      return fakeChild();
    };
    const env = { HOME: home };

    assert.equal(
      launchAgentSessionCaptureWake(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: gone,
          observedAt: HOOK_FIRED_AT,
        },
        spawn,
        env
      ),
      true
    );
    assert.equal(
      launchAgentSessionFinalize(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: gone,
          transcriptPath: '/tmp/transcript.jsonl',
          source: 'hook',
        },
        spawn,
        env
      ),
      true
    );

    assert.equal(launches.length, 2);
    for (const launch of launches) {
      assert.equal(launch.options.cwd, home);
      assert.equal(launch.options.detached, true);
      // The evidence travels unchanged; only the launch moved.
      assert.equal(JSON.parse(launch.args[1]).cwd, gone);
    }
  });
});

test('the wake and finalize CLI processes run from the home directory and keep --cwd evidence', () => {
  withHome((home) => {
    const gone = vanishedDirectory(home);
    const env = { HOME: home, POLYGRAPH_CLI: '/opt/polygraph' };
    const invocations = [];
    const spawn = (command, args, options) => {
      invocations.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    };

    assert.equal(
      ensureAgentSessionCapture(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: gone,
          observedAt: HOOK_FIRED_AT,
        },
        spawn,
        env
      ),
      true
    );
    assert.equal(
      finalizeAgentSession(
        { agentType: 'claude', agentSessionId: 'claude-session', cwd: gone, source: 'hook' },
        spawn,
        env
      ),
      true
    );

    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].args[0], '_ensure-agent-session-capture');
    assert.equal(invocations[0].options.cwd, home);
    assert.equal(invocations[0].args.includes('--cwd'), false);
    assert.equal(invocations[1].args[0], '_finalize-agent-session');
    assert.equal(invocations[1].options.cwd, home);
    assert.deepEqual(invocations[1].args.slice(5, 7), ['--cwd', gone]);

    // The legacy mapping fallback keeps recording the vanished directory as
    // the mapping's working directory: evidence is the claim's, not the
    // launch's.
    const fallback = [];
    assert.equal(
      ensureAgentSessionCapture(
        {
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: gone,
          observedAt: HOOK_FIRED_AT,
        },
        (command, args, options) => {
          fallback.push({ command, args, options });
          return fallback.length === 1
            ? { status: 1, stdout: OLD_CLI_UNSUPPORTED_STDOUT, stderr: '' }
            : { status: 0, stdout: '', stderr: '' };
        },
        env
      ),
      true
    );
    assert.equal(fallback.length, 2);
    assert.equal(fallback[1].args[0], '_link-agent-session');
    assert.equal(fallback[1].options.cwd, home);
    assert.deepEqual(fallback[1].args.slice(5, 7), ['--cwd', gone]);
  });
});

// The shipped hooks, run as the harness runs them, after the harness working
// directory has been removed: the hook stays silent and exits promptly, the
// detached worker still reaches the CLI from the home directory, and the CLI
// still receives the original directory as --cwd evidence where the command
// carries it.
for (const [script, payloadFor, expectedCommand] of [
  [
    'finalize-agent-session.mjs claude',
    (gone) => ({
      hook_event_name: 'SessionEnd',
      session_id: 'claude-session',
      cwd: gone,
      transcript_path: '/tmp/transcript.jsonl',
      reason: 'other',
    }),
    '_finalize-agent-session',
  ],
  [
    'ensure-agent-session-capture.mjs cursor --detach',
    (gone) => ({
      hook_event_name: 'afterAgentResponse',
      conversation_id: 'cursor/conversation-id',
      workspace_roots: [gone],
      text: 'answer text that stays in the transcript',
    }),
    '_ensure-agent-session-capture',
  ],
]) {
  test(`hook "${script}" still reaches the CLI after the harness cwd vanished`, () => {
    withHome((home) => {
      const gone = vanishedDirectory(home);
      const marker = join(home, 'cli-invocation.json');
      const cliPath = join(home, 'polygraph cli.js');
      writeFileSync(
        cliPath,
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(0);\n`
      );
      const [file, ...args] = script.split(' ');

      const hook = spawnSync(process.execPath, [join(hooksDir, file), ...args], {
        cwd: hooksDir,
        encoding: 'utf8',
        input: JSON.stringify(payloadFor(gone)),
        env: hookEnv({ HOME: home, POLYGRAPH_CLI: cliPath }),
      });
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stdout, '');

      const deadline = Date.now() + 10_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      assert.equal(existsSync(marker), true, 'detached worker never reached the CLI');
      const { argv, cwd } = JSON.parse(readFileSync(marker, 'utf8'));
      assert.equal(argv[0], expectedCommand);
      assert.equal(realpathSync(cwd), realpathSync(home));
      if (expectedCommand === '_finalize-agent-session') {
        assert.deepEqual(argv.slice(5, 7), ['--cwd', gone]);
      } else {
        assert.equal(argv.includes('--cwd'), false);
      }
      // Nothing failed on the way: no durable failure entry was written.
      assert.equal(existsSync(join(home, '.polygraph', 'logs', 'hooks.log')), false);
    });
  });
}

test('processWorkingDirectory reports the live cwd', () => {
  assert.equal(processWorkingDirectory(), process.cwd());
});

// The same shipped hooks when the hook process itself is already running
// from a directory that no longer exists: a harness can start a hook in a
// directory removed moments earlier, or remove it while the hook runs, and
// process.cwd() then fails with uv_cwd. The hook must stay silent, exit
// cleanly, still reach the CLI from the home directory, and keep whatever
// directory the payload carried as --cwd evidence. The deleted directory
// doubles as the harness cwd in the payload, the realistic shape of an
// archived session worktree. A live process's cwd cannot be removed on
// Windows, so these run on POSIX only.
function runHookFromDeletedCwd({ home, gone, hookFile, args, payload, cli }) {
  const hookPath = join(hooksDir, hookFile);
  const bootstrap = join(home, 'run from deleted cwd.mjs');
  writeFileSync(
    bootstrap,
    [
      "import { rmSync } from 'node:fs';",
      `process.chdir(${JSON.stringify(gone)});`,
      `rmSync(${JSON.stringify(gone)}, { recursive: true });`,
      `process.argv.splice(1, Infinity, ${JSON.stringify(hookPath)}, ...${JSON.stringify(args)});`,
      `await import(${JSON.stringify(pathToFileURL(hookPath).href)});`,
      '',
    ].join('\n')
  );
  return spawnSync(process.execPath, [bootstrap], {
    cwd: home,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: hookEnv({ HOME: home, POLYGRAPH_CLI: cli }),
  });
}

const DELETED_CWD_CASES = [
  {
    name: 'finalize-agent-session.mjs claude keeps the payload cwd as --cwd evidence',
    hookFile: 'finalize-agent-session.mjs',
    args: ['claude'],
    payload: (gone) => ({
      hook_event_name: 'SessionEnd',
      session_id: 'claude-session',
      cwd: gone,
      transcript_path: '/tmp/transcript.jsonl',
      reason: 'other',
    }),
    command: '_finalize-agent-session',
    detached: true,
    cwdEvidence: (gone) => ['--cwd', gone],
  },
  {
    name: 'finalize-agent-session.mjs claude without a payload cwd omits --cwd',
    hookFile: 'finalize-agent-session.mjs',
    args: ['claude'],
    payload: () => ({
      hook_event_name: 'SessionEnd',
      session_id: 'claude-session',
      transcript_path: '/tmp/transcript.jsonl',
      reason: 'other',
    }),
    command: '_finalize-agent-session',
    detached: true,
    cwdEvidence: () => undefined,
  },
  {
    name: 'ensure-agent-session-capture.mjs claude runs the bounded wake inline',
    hookFile: 'ensure-agent-session-capture.mjs',
    args: ['claude'],
    payload: (gone) => ({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      cwd: gone,
      transcript_path: '/tmp/transcript.jsonl',
      prompt: 'prompt text that stays in the transcript',
    }),
    command: '_ensure-agent-session-capture',
    detached: false,
    cwdEvidence: () => undefined,
  },
  {
    name: 'ensure-agent-session-capture.mjs cursor --detach without workspace roots',
    hookFile: 'ensure-agent-session-capture.mjs',
    args: ['cursor', '--detach'],
    payload: () => ({
      hook_event_name: 'afterAgentResponse',
      conversation_id: 'cursor/conversation-id',
      text: 'answer text that stays in the transcript',
    }),
    command: '_ensure-agent-session-capture',
    detached: true,
    cwdEvidence: () => undefined,
  },
];

for (const scenario of DELETED_CWD_CASES) {
  test(
    `hook already running from a deleted cwd: ${scenario.name}`,
    { skip: process.platform === 'win32' && 'a live process cwd cannot be removed on Windows' },
    () => {
      withHome((home) => {
        const gone = join(home, 'deleted hook cwd');
        mkdirSync(gone);
        const marker = join(home, 'cli-invocation.json');
        const cli = join(home, 'polygraph cli.js');
        writeFileSync(
          cli,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(0);\n`
        );

        const hook = runHookFromDeletedCwd({
          home,
          gone,
          hookFile: scenario.hookFile,
          args: scenario.args,
          payload: scenario.payload(gone),
          cli,
        });
        assert.equal(existsSync(gone), false);
        assert.equal(hook.status, 0, hook.stderr);
        assert.equal(hook.stdout, '');
        // No uv_cwd stack trace or any other noise reaches the harness.
        assert.equal(hook.stderr, '');

        if (scenario.detached) {
          const deadline = Date.now() + 10_000;
          while (!existsSync(marker) && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          }
        }
        assert.equal(existsSync(marker), true, 'the hook never reached the CLI');
        const { argv, cwd } = JSON.parse(readFileSync(marker, 'utf8'));
        assert.equal(argv[0], scenario.command);
        assert.equal(realpathSync(cwd), realpathSync(home));
        const evidence = scenario.cwdEvidence(gone);
        if (evidence) {
          assert.deepEqual(argv.slice(argv.indexOf('--cwd'), argv.indexOf('--cwd') + 2), evidence);
        } else {
          assert.equal(argv.includes('--cwd'), false);
        }
        assert.equal(existsSync(join(home, '.polygraph', 'logs', 'hooks.log')), false);
      });
    }
  );
}
