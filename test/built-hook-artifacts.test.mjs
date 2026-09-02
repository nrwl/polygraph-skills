import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');

// Every assertion below inspects the real published layout, so the dist tree
// is rebuilt once up front exactly the way the release workflow builds it.
const build = spawnSync(process.execPath, ['scripts/sync-artifacts.mjs'], {
  cwd: rootDir,
  encoding: 'utf8',
  env: process.env,
});

function localModuleSpecifiers(source) {
  const specifiers = [];
  const importPattern = /(?:\bfrom\s*|\bimport\s*)['"](\.[^'"]+)['"]/g;
  const urlPattern =
    /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

  for (const pattern of [importPattern, urlPattern]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function assertCompleteLocalModuleGraph(entryPath) {
  const pending = [entryPath];
  const visited = new Set();

  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    assert.equal(existsSync(modulePath), true, `missing packaged module ${modulePath}`);

    const source = readFileSync(modulePath, 'utf8');
    for (const specifier of localModuleSpecifiers(source)) {
      const dependency = resolve(dirname(modulePath), specifier);
      assert.equal(
        existsSync(dependency),
        true,
        `${modulePath} references missing local module ${specifier}`
      );
      if (['.js', '.mjs', '.cjs'].includes(extname(dependency))) {
        pending.push(dependency);
      }
    }
  }
}

function manifestHookScripts(harness) {
  const hooksDir = join(distDir, harness, 'hooks');
  const manifest = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8'));
  const commands = [];

  for (const registrations of Object.values(manifest.hooks)) {
    for (const registration of registrations) {
      if (registration.command) commands.push(registration.command);
      for (const hook of registration.hooks ?? []) {
        if (hook.command) commands.push(hook.command);
      }
    }
  }

  return commands.map((command) => {
    const script = command.match(/hooks\/([^\s]+\.[cm]?js)/)?.[1];
    assert.ok(script, `could not resolve packaged hook command: ${command}`);
    return join(hooksDir, script);
  });
}

// The observed Shell 0.1.x response to the hidden ensure command: root usage
// on stdout, exit status 1, nothing on stderr.
const OLD_CLI_USAGE =
  'Usage: polygraph\\nPolygraph CLI for cross-repo coordination\\n\\n' +
  'Commands:\\n  auth - Authentication and environment selection\\n\\n' +
  'Validation failed for one or more options\\n' +
  '  - Unknown argument: _ensure-agent-session-capture\\n' +
  '  - Unknown argument: --agent-type\\n';

function writeOldCli(path) {
  writeFileSync(
    path,
    [
      "if (process.argv[2] === '_ensure-agent-session-capture') {",
      `  process.stdout.write('${OLD_CLI_USAGE}');`,
      '  process.exit(1);',
      '}',
      "if (process.argv[2] === '_link-agent-session' && process.argv.slice(-2).join(' ') === '--source hook') {",
      '  process.exit(0);',
      '}',
      'process.exit(3);',
      '',
    ].join('\n')
  );
}

// The suite itself may run inside a managed Polygraph agent, whose ambient
// child/session evidence would rightly make every wake decline.
function workerEnv(home, cliPath) {
  const env = { ...process.env, HOME: home, POLYGRAPH_CLI: cliPath };
  delete env.POLYGRAPH_CHILD_AGENT;
  delete env.POLYGRAPH_SESSION_ID;
  delete env.POLYGRAPH_CAPTURE_TOKEN;
  return env;
}

function writeFinalizeCli(path) {
  writeFileSync(
    path,
    [
      "if (process.argv[2] === '_finalize-agent-session' && process.argv.includes('--source') && !process.argv.includes('--pid') && process.argv[process.argv.indexOf('--observed-at') + 1] === '1767225600000') {",
      '  process.exit(0);',
      '}',
      'process.exit(3);',
      '',
    ].join('\n')
  );
}

test('dist assembly succeeds', () => {
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
});

test('built harness artifacts contain every executable hook module dependency', () => {
  for (const harness of ['claude', 'codex', 'cursor']) {
    for (const entryPath of manifestHookScripts(harness)) {
      assertCompleteLocalModuleGraph(entryPath);
    }
  }

  const openCodeRoot = join(distDir, 'opencode');
  assertCompleteLocalModuleGraph(join(openCodeRoot, 'server.js'));

  const openCodeMainBundle = readFileSync(
    join(openCodeRoot, 'agent-session-link.mjs'),
    'utf8'
  );
  // The host-loop bundle may only hand wakes to the detached worker; the
  // bounded synchronous wake runner must be bundled into the worker alone.
  assert.doesNotMatch(openCodeMainBundle, /\brunCaptureCliSync\b/);
  assert.doesNotMatch(openCodeMainBundle, /\bensureAgentSessionCapture\b/);
  assert.match(openCodeMainBundle, /\blaunchDetachedHookWorker\b/);

  const openCodeWorkerBundle = readFileSync(
    join(openCodeRoot, 'ensure-agent-session-capture-worker.mjs'),
    'utf8'
  );
  assert.match(openCodeWorkerBundle, /\brunCaptureCliSync\b/);
  assert.match(openCodeWorkerBundle, /_ensure-agent-session-capture/);
  assert.match(openCodeWorkerBundle, /_link-agent-session/);

  const openCodePackage = JSON.parse(
    readFileSync(join(openCodeRoot, 'package.json'), 'utf8')
  );
  assert.ok(
    openCodePackage.files.includes('ensure-agent-session-capture-worker.mjs')
  );
});

test('the packaged cursor finalize worker finalizes end to end without a PID', () => {
  const home = mkdtempSync(join(tmpdir(), 'pg packaged finalize-'));
  try {
    const cliPath = join(home, 'polygraph cli.js');
    writeFinalizeCli(cliPath);

    const result = spawnSync(
      process.execPath,
      [
        join(distDir, 'cursor', 'hooks', 'finalize-agent-session-worker.mjs'),
        JSON.stringify({
          agentType: 'cursor',
          agentSessionId: 'cursor/conversation-id',
          cwd: home,
          transcriptPath: join(home, 'transcript.jsonl'),
          source: 'hook',
          observedAt: 1_767_225_600_000,
        }),
      ],
      { cwd: home, encoding: 'utf8', env: workerEnv(home, cliPath) }
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The detached wake worker runs from the published layout of every harness
// with only its packaged siblings available, against a plain JS CLI entry in
// a path with spaces that still answers with the old root usage.
for (const [harness, workerPath] of [
  ['claude', join('claude', 'hooks', 'ensure-agent-session-capture-worker.mjs')],
  ['codex', join('codex', 'hooks', 'ensure-agent-session-capture-worker.mjs')],
  ['cursor', join('cursor', 'hooks', 'ensure-agent-session-capture-worker.mjs')],
  ['opencode', join('opencode', 'ensure-agent-session-capture-worker.mjs')],
]) {
  test(`the packaged ${harness} wake worker completes the old-CLI fallback end to end`, () => {
    const home = mkdtempSync(join(tmpdir(), 'pg packaged worker-'));
    try {
      const cliPath = join(home, 'polygraph cli.js');
      writeOldCli(cliPath);

      const result = spawnSync(
        process.execPath,
        [
          join(distDir, workerPath),
          JSON.stringify({
            agentType: harness,
            agentSessionId: `${harness}-session`,
            cwd: home,
            observedAt: Date.now(),
          }),
        ],
        {
          cwd: home,
          encoding: 'utf8',
          env: workerEnv(home, cliPath),
        }
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.equal(existsSync(join(home, '.polygraph', 'logs', 'hooks.log')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

// The packaged command-hook scripts are the source scripts byte for byte,
// and each harness ships exactly the manifest it registers, so a source fix
// can never be published stale.
test('packaged hook scripts and manifests are byte-identical to source', () => {
  const manifests = {
    claude: join(rootDir, 'source', 'hooks', 'hooks.json'),
    codex: join(rootDir, 'source', 'codex', 'hooks', 'hooks.json'),
    cursor: join(rootDir, 'source', 'cursor', 'hooks', 'hooks.json'),
  };
  for (const [harness, manifestPath] of Object.entries(manifests)) {
    const hooksDir = join(distDir, harness, 'hooks');
    const shipped = readdirSync(hooksDir).filter((name) => name.endsWith('.mjs'));
    assert.ok(shipped.length > 0, harness);
    for (const name of shipped) {
      assert.equal(
        readFileSync(join(hooksDir, name), 'utf8'),
        readFileSync(join(rootDir, 'source', 'hooks', name), 'utf8'),
        `${harness}/hooks/${name} drifted from source/hooks/${name}`
      );
    }
    assert.equal(
      readFileSync(join(hooksDir, 'hooks.json'), 'utf8'),
      readFileSync(manifestPath, 'utf8'),
      harness
    );
  }

  // Finalization ships only where it is wired.
  for (const harness of ['claude', 'cursor']) {
    for (const name of [
      'finalize-agent-session.mjs',
      'finalize-agent-session-worker.mjs',
      'agent-session-finalize.mjs',
    ]) {
      assert.equal(existsSync(join(distDir, harness, 'hooks', name)), true, `${harness} ${name}`);
    }
  }
  assert.equal(existsSync(join(distDir, 'codex', 'hooks', 'finalize-agent-session.mjs')), false);
  for (const bundle of ['agent-session-link.mjs', 'ensure-agent-session-capture-worker.mjs']) {
    assert.doesNotMatch(
      readFileSync(join(distDir, 'opencode', bundle), 'utf8'),
      /_finalize-agent-session/,
      bundle
    );
  }
});

test('the packaged OpenCode linker launches links from an existing directory and keeps --cwd evidence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pg packaged opencode link-'));
  try {
    const gone = join(home, 'archived session worktree');
    mkdirSync(gone);
    rmSync(gone, { recursive: true, force: true });

    const { createOpenCodeSessionLinker } = await import(
      pathToFileURL(join(distDir, 'opencode', 'agent-session-link.mjs')).href
    );
    const invocations = [];
    const linker = createOpenCodeSessionLinker({
      client: { session: { get: async ({ path }) => ({ data: { id: path.id } }) } },
      directory: gone,
      env: { HOME: home, POLYGRAPH_SESSION_ID: 'poly/session' },
      pid: 2468,
      spawn(command, args, options) {
        invocations.push({ command, args, options });
        return { status: 0, stderr: '' };
      },
    });

    assert.equal(await linker.fromEnvironment('root'), true);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].args[0], '_link-agent-session');
    // The launch moved to home; the recorded working directory did not.
    assert.equal(invocations[0].options.cwd, home);
    const cwdIndex = invocations[0].args.indexOf('--cwd');
    assert.deepEqual(invocations[0].args.slice(cwdIndex, cwdIndex + 2), ['--cwd', gone]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
