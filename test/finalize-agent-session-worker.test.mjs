import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../source/hooks/finalize-agent-session-worker.mjs';
import { FINALIZE_TIMEOUT_MS } from '../source/hooks/agent-session-finalize.mjs';

const WORKER_PATH = fileURLToPath(
  new URL('../source/hooks/finalize-agent-session-worker.mjs', import.meta.url)
);
// The session-end hook's own clock reading, serialized into the claim.
const HOOK_FIRED_AT = 1_767_225_600_000;

test('worker finalizes a parsed claim through the CLI and reports success', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pg repo with spaces-'));
  let invocation;
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'claude',
      agentSessionId: 'claude-session',
      cwd: repo,
      transcriptPath: '/tmp/transcript exact.jsonl',
      source: 'hook',
      observedAt: HOOK_FIRED_AT,
    }),
    env: { POLYGRAPH_CLI: '/opt/polygraph' },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
    logFailure() {
      throw new Error('success must not log a failure');
    },
    writeFailure() {
      throw new Error('success must not write a failure');
    },
  });

  assert.equal(result, true);
  assert.equal(invocation.command, '/opt/polygraph');
  assert.deepEqual(invocation.args, [
    '_finalize-agent-session',
    '--agent-type',
    'claude',
    '--agent-session-id',
    'claude-session',
    '--cwd',
    repo,
    '--transcript-path',
    '/tmp/transcript exact.jsonl',
    '--source',
    'hook',
    '--observed-at',
    String(HOOK_FIRED_AT),
  ]);
  assert.equal(invocation.options.cwd, repo);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert.ok(invocation.options.timeout <= FINALIZE_TIMEOUT_MS);
  rmSync(repo, { recursive: true, force: true });
});

test('worker owns CLI failures: durable log plus inherited stream, never a throw', () => {
  const written = [];
  const logged = [];
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'claude',
      agentSessionId: 'claude-session',
      source: 'hook',
      observedAt: HOOK_FIRED_AT,
    }),
    env: { POLYGRAPH_CLI: '/opt/polygraph' },
    spawn: () => ({ status: 3, stderr: 'finalize refused' }),
    logFailure(hook, error, meta) {
      logged.push({ hook, error, meta });
    },
    writeFailure(error, claim) {
      written.push({ error, claim });
    },
  });

  assert.equal(result, false);
  assert.equal(written.length, 1);
  assert.match(written[0].error.message, /status 3: finalize refused/);
  assert.equal(written[0].claim.agentSessionId, 'claude-session');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].hook, 'claude:finalize-agent-session-worker');
  assert.deepEqual(logged[0].meta, {
    agentSessionId: 'claude-session',
    cli: '/opt/polygraph',
  });
});

test('worker names the finalized harness in its failure diagnostics', () => {
  const logged = [];
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'cursor',
      agentSessionId: 'cursor/conversation-id',
      cwd: '/workspace/cursor repo',
      transcriptPath: '/tmp/cursor transcript.jsonl',
      source: 'hook',
      observedAt: HOOK_FIRED_AT,
    }),
    env: { POLYGRAPH_CLI: '/opt/polygraph' },
    spawn: () => ({ status: 3, stderr: 'finalize refused' }),
    logFailure(hook, error, meta) {
      logged.push({ hook, error, meta });
    },
    writeFailure() {},
  });

  assert.equal(result, false);
  assert.equal(logged[0].hook, 'cursor:finalize-agent-session-worker');
  assert.equal(logged[0].meta.agentSessionId, 'cursor/conversation-id');
});

test('worker contains an unparseable claim without an identity', () => {
  const written = [];
  const logged = [];
  const result = main({
    serializedClaim: 'not json',
    env: {},
    spawn() {
      throw new Error('an unparseable claim must never reach the CLI');
    },
    logFailure(hook, error, meta) {
      logged.push({ hook, error, meta });
    },
    writeFailure(error, claim) {
      written.push({ error, claim });
    },
  });

  assert.equal(result, false);
  assert.equal(written.length, 1);
  assert.equal(written[0].claim, undefined);
  assert.equal(logged[0].meta.agentSessionId, undefined);
  assert.equal(logged[0].meta.cli, 'polygraph');
});

test('detached worker process durably logs a CLI failure on its own', () => {
  const home = mkdtempSync(join(tmpdir(), 'pg finalize worker-'));
  try {
    const workDir = join(home, 'repo with spaces');
    mkdirSync(workDir, { recursive: true });
    // A plain JS CLI entry: launching it directly fails, proving the worker's
    // Node re-exec fallback end-to-end before the scripted nonzero exit.
    const cliPath = join(home, 'fake polygraph.mjs');
    writeFileSync(cliPath, 'process.stderr.write("finalize refused"); process.exit(3);\n');

    const run = spawnSync(
      process.execPath,
      [
        WORKER_PATH,
        JSON.stringify({
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: workDir,
          source: 'hook',
          observedAt: HOOK_FIRED_AT,
        }),
      ],
      { encoding: 'utf8', env: { HOME: home, POLYGRAPH_CLI: cliPath } }
    );

    assert.equal(run.status, 1);
    const streamEntry = JSON.parse(run.stderr.trim().split('\n').at(-1));
    assert.equal(streamEntry.hook, 'claude:finalize-agent-session-worker');
    assert.match(streamEntry.error, /status 3: finalize refused/);
    assert.equal(streamEntry.agentSessionId, 'claude-session');

    const logEntry = JSON.parse(
      readFileSync(join(home, '.polygraph', 'logs', 'hooks.log'), 'utf8')
        .trim()
        .split('\n')
        .at(-1)
    );
    assert.equal(logEntry.hook, 'claude:finalize-agent-session-worker');
    assert.match(logEntry.error, /status 3: finalize refused/);
    assert.equal(logEntry.cli, cliPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('detached worker process exits zero when the CLI finalizes cleanly', () => {
  const home = mkdtempSync(join(tmpdir(), 'pg finalize worker-'));
  try {
    const cliPath = join(home, 'fake polygraph.mjs');
    writeFileSync(cliPath, 'process.exit(0);\n');

    const run = spawnSync(
      process.execPath,
      [
        WORKER_PATH,
        JSON.stringify({
          agentType: 'claude',
          agentSessionId: 'claude-session',
          cwd: home,
          source: 'hook',
          observedAt: HOOK_FIRED_AT,
        }),
      ],
      { encoding: 'utf8', env: { HOME: home, POLYGRAPH_CLI: cliPath } }
    );

    assert.equal(run.status, 0);
    assert.equal(run.stderr.trim(), '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('worker forwards the serialized observation time and never its own clock', () => {
  // The claim was stamped when the session-end hook fired, long before this
  // worker ran; the argv must say so.
  let invocation;
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'claude',
      agentSessionId: 'claude-session',
      cwd: '/workspace/repo',
      source: 'hook',
      observedAt: HOOK_FIRED_AT,
    }),
    env: { POLYGRAPH_CLI: '/opt/polygraph' },
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stderr: '' };
    },
    logFailure() {
      throw new Error('success must not log a failure');
    },
    writeFailure() {
      throw new Error('success must not write a failure');
    },
  });

  assert.equal(result, true);
  const observedAt = Number(invocation.args[invocation.args.indexOf('--observed-at') + 1]);
  assert.equal(observedAt, HOOK_FIRED_AT);
  assert.ok(observedAt < Date.now() - 60_000);
});

test('worker refuses a claim without an observation time before reaching the CLI', () => {
  const logged = [];
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'claude',
      agentSessionId: 'claude-session',
      cwd: '/workspace/repo',
      source: 'hook',
    }),
    env: { POLYGRAPH_CLI: '/opt/polygraph' },
    spawn() {
      throw new Error('a claim without observedAt must never reach the CLI');
    },
    logFailure(hook, error, meta) {
      logged.push({ hook, error, meta });
    },
    writeFailure() {},
  });

  assert.equal(result, false);
  assert.equal(logged.length, 1);
  assert.match(logged[0].error.message, /observedAt is required/);
  assert.equal(logged[0].meta.agentSessionId, 'claude-session');
});
