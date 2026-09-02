import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../source/hooks/ensure-agent-session-capture-worker.mjs';
import { ENSURE_CAPTURE_TIMEOUT_MS } from '../source/hooks/agent-session-capture.mjs';

const WORKER_PATH = fileURLToPath(
  new URL('../source/hooks/ensure-agent-session-capture-worker.mjs', import.meta.url)
);

test('worker wakes capture from a parsed claim and reports success', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pg repo with spaces-'));
  let invocation;
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'codex',
      agentSessionId: 'codex-session',
      observedAt: 1767225600000,
      cwd: repo,
      transcriptPath: '/tmp/rollout exact.jsonl',
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
    '_ensure-agent-session-capture',
    '--agent-type',
    'codex',
    '--agent-session-id',
    'codex-session',
    '--observed-at',
    '1767225600000',
  ]);
  assert.equal(invocation.options.cwd, repo);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.killSignal, 'SIGKILL');
  assert.ok(invocation.options.timeout <= ENSURE_CAPTURE_TIMEOUT_MS);
  rmSync(repo, { recursive: true, force: true });
});

test('worker owns wake failures: durable log plus inherited stream, never a throw', () => {
  const written = [];
  const logged = [];
  const result = main({
    serializedClaim: JSON.stringify({
      agentType: 'cursor',
      agentSessionId: 'cursor-session',
      observedAt: 1767225600000,
    }),
    env: { POLYGRAPH_CLI: '/opt/polygraph' },
    spawn: () => ({ status: 3, stderr: 'capture refused' }),
    logFailure(hook, error, meta) {
      logged.push({ hook, error, meta });
    },
    writeFailure(error, claim) {
      written.push({ error, claim });
    },
  });

  assert.equal(result, false);
  assert.equal(written.length, 1);
  assert.match(written[0].error.message, /status 3: capture refused/);
  assert.equal(written[0].claim.agentSessionId, 'cursor-session');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].hook, 'cursor:ensure-agent-session-capture-worker');
  assert.deepEqual(logged[0].meta, {
    agentSessionId: 'cursor-session',
    cli: '/opt/polygraph',
  });
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
  assert.equal(logged[0].hook, 'unknown:ensure-agent-session-capture-worker');
  assert.equal(logged[0].meta.cli, 'polygraph');
});

test('detached worker process handles the actual old-CLI usage shape end to end', () => {
  // The fake CLI is a plain JS entry in a path with spaces: the worker must
  // run it through Node, see the unsupported marker on the preferred
  // command, and succeed via the legacy mapping command with provenance
  // intact.
  const home = mkdtempSync(join(tmpdir(), 'pg ensure worker-'));
  try {
    const workDir = join(home, 'repo with spaces');
    mkdirSync(workDir, { recursive: true });
    const cliPath = join(home, 'fake polygraph.mjs');
    writeFileSync(
      cliPath,
      [
        "if (process.argv[2] === '_ensure-agent-session-capture') {",
        "  process.stdout.write('Usage: polygraph\\nPolygraph CLI for cross-repo coordination\\n\\nValidation failed for one or more options\\n  - Unknown argument: _ensure-agent-session-capture\\n  - Unknown argument: --agent-type\\n  - Unknown argument: opencode\\n  - Unknown argument: --agent-session-id\\n  - Unknown argument: opencode-session\\n');",
        '  process.exit(1);',
        '}',
        "if (process.argv[2] === '_link-agent-session' && process.argv.slice(-2).join(' ') === '--source hook') {",
        '  process.exit(0);',
        '}',
        'process.exit(9);',
        '',
      ].join('\n')
    );

    const run = spawnSync(
      process.execPath,
      [
        WORKER_PATH,
        JSON.stringify({
          agentType: 'opencode',
          agentSessionId: 'opencode-session',
          observedAt: 1767225600000,
          cwd: workDir,
        }),
      ],
      { encoding: 'utf8', env: { HOME: home, POLYGRAPH_CLI: cliPath } }
    );

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr.trim(), '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('detached worker process durably logs a wake failure on its own', () => {
  const home = mkdtempSync(join(tmpdir(), 'pg ensure worker-'));
  try {
    const cliPath = join(home, 'fake polygraph.mjs');
    writeFileSync(cliPath, 'process.stderr.write("capture refused"); process.exit(3);\n');

    const run = spawnSync(
      process.execPath,
      [
        WORKER_PATH,
        JSON.stringify({
          agentType: 'codex',
          agentSessionId: 'codex-session',
          observedAt: 1767225600000,
          cwd: home,
        }),
      ],
      { encoding: 'utf8', env: { HOME: home, POLYGRAPH_CLI: cliPath } }
    );

    assert.equal(run.status, 1);
    const streamEntry = JSON.parse(run.stderr.trim().split('\n').at(-1));
    assert.equal(streamEntry.hook, 'codex:ensure-agent-session-capture-worker');
    assert.match(streamEntry.error, /status 3: capture refused/);

    const logEntry = JSON.parse(
      readFileSync(join(home, '.polygraph', 'logs', 'hooks.log'), 'utf8')
        .trim()
        .split('\n')
        .at(-1)
    );
    assert.equal(logEntry.hook, 'codex:ensure-agent-session-capture-worker');
    assert.match(logEntry.error, /status 3: capture refused/);
    assert.equal(logEntry.cli, cliPath);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
