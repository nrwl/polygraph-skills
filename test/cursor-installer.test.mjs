import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkCursorUsageStopHook,
  checkInstall,
  getCursorUserHooksPath,
  getPluginInstallPath,
  installPlugin,
  registerCursorUsageStopHook,
  resolveUserHome,
} from '../source/cursor/lib/installer.mjs';

test('resolveUserHome expands ~ and falls back to homedir', () => {
  const home = '/tmp/example-home';
  assert.equal(resolveUserHome({ HOME: home }), home);
});

test('installPlugin copies the payload into ~/.polygraph/plugins/cursor/polygraph', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');
  const expectedPluginPath = getPluginInstallPath(homeDir);

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });

  assert.equal(result.ok, true);
  assert.equal(result.copied, true);
  assert.equal(result.pluginPath, expectedPluginPath);
  assert.equal(existsSync(join(result.pluginPath, 'plugin.json')), true);
  assert.equal(
    existsSync(join(result.pluginPath, 'skills', 'polygraph', 'SKILL.md')),
    true
  );
  // The sessionStart identity hook must land next to the skills so
  // cursor-agent discovers it from the same --plugin-dir payload.
  assert.equal(
    existsSync(join(result.pluginPath, 'hooks', 'hooks.json')),
    true
  );
  // The installer bin must never ride along: cursor-agent --plugin-dir loads
  // everything in the directory as plugin content.
  assert.equal(existsSync(join(result.pluginPath, 'bin')), false);

  const installedPkg = JSON.parse(
    readFileSync(join(result.pluginPath, 'package.json'), 'utf8')
  );
  assert.equal(installedPkg.version, '1.2.3');
});

test('installPlugin is a no-op for a complete same-version install and refreshes on version change', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');

  const first = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(first.copied, true);

  const second = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(second.copied, false);
  assert.equal(second.previousVersion, '1.2.3');

  writeFixturePackageJson(fixture.packageRoot, '1.3.0');
  const third = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(third.copied, true);
  assert.equal(third.previousVersion, '1.2.3');
  assert.equal(third.version, '1.3.0');
  assert.equal(third.pluginUpdated, true);
});

test('installPlugin repairs an incomplete install', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');
  const pluginPath = getPluginInstallPath(homeDir);

  // Simulate a partial previous install: version stamp without payload.
  mkdirSync(pluginPath, { recursive: true });
  writeFileSync(
    join(pluginPath, 'package.json'),
    JSON.stringify({ version: '1.2.3' })
  );

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(result.copied, true);
  assert.equal(existsSync(join(pluginPath, 'plugin.json')), true);
});

test('checkInstall reports missing, present, and up-to-date states', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');

  const missing = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.installed, false);

  installPlugin({ packageRoot: fixture.packageRoot, env: { HOME: homeDir } });

  const present = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(present.ok, true);
  assert.equal(present.installedVersion, '1.2.3');
  assert.equal(present.upToDate, true);

  writeFixturePackageJson(fixture.packageRoot, '1.3.0');
  const stale = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.upToDate, false);
});

test('installPlugin rejects a payload whose manifest is not the polygraph plugin', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3', { manifestName: 'other' });

  assert.throws(
    () => installPlugin({ packageRoot: fixture.packageRoot, env: { HOME: homeDir } }),
    /Expected plugin\.json name/
  );
});

test('installPlugin registers the usage stop hook in the user hooks.json', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });

  assert.equal(result.userHooks.registered, true);
  const config = JSON.parse(
    readFileSync(getCursorUserHooksPath(homeDir), 'utf8')
  );
  assert.equal(config.hooks.stop.length, 1);
  assert.match(config.hooks.stop[0].command, /record-cursor-usage\.mjs/);
  assert.equal(config.hooks.stop[0].command.includes(result.pluginPath), true);
});

test('registerCursorUsageStopHook merges without touching other entries and is idempotent', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const hooksPath = getCursorUserHooksPath(homeDir);
  mkdirSync(join(homeDir, '.cursor'), { recursive: true });
  writeFileSync(
    hooksPath,
    JSON.stringify({
      version: 1,
      hooks: {
        stop: [
          { command: '/opt/other-tool/hook.sh Stop' },
          { command: 'node "/old/install/hooks/record-cursor-usage.mjs"' },
        ],
        beforeSubmitPrompt: [{ command: '/opt/other-tool/hook.sh Start' }],
      },
    })
  );

  const pluginPath = join(homeDir, '.polygraph', 'plugins', 'cursor', 'polygraph');
  const first = registerCursorUsageStopHook({ userHome: homeDir, pluginPath });
  assert.equal(first.registered, true);
  assert.equal(first.changed, true);

  const config = JSON.parse(readFileSync(hooksPath, 'utf8'));
  // The other tool's entries survive; the stale polygraph path is replaced.
  assert.equal(config.hooks.beforeSubmitPrompt.length, 1);
  assert.equal(config.hooks.stop.length, 2);
  assert.equal(config.hooks.stop[0].command, '/opt/other-tool/hook.sh Stop');
  assert.equal(config.hooks.stop[1].command.includes(pluginPath), true);

  const second = registerCursorUsageStopHook({ userHome: homeDir, pluginPath });
  assert.equal(second.registered, true);
  assert.equal(second.changed, false);
});

test('registerCursorUsageStopHook leaves an unparsable hooks.json untouched', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const hooksPath = getCursorUserHooksPath(homeDir);
  mkdirSync(join(homeDir, '.cursor'), { recursive: true });
  writeFileSync(hooksPath, '{not json');

  const result = registerCursorUsageStopHook({
    userHome: homeDir,
    pluginPath: join(homeDir, 'plugin'),
  });
  assert.equal(result.registered, false);
  assert.equal(result.reason, 'unparsable');
  assert.equal(readFileSync(hooksPath, 'utf8'), '{not json');
});

test('registerCursorUsageStopHook creates the hooks.json when absent', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const pluginPath = join(homeDir, 'plugin');

  const result = registerCursorUsageStopHook({ userHome: homeDir, pluginPath });
  assert.equal(result.registered, true);

  const config = JSON.parse(
    readFileSync(getCursorUserHooksPath(homeDir), 'utf8')
  );
  assert.equal(config.version, 1);
  assert.equal(config.hooks.stop.length, 1);
  // Atomic write: the temp file never survives a successful merge.
  assert.deepEqual(
    readdirSync(join(homeDir, '.cursor')).filter((name) =>
      name.endsWith('.tmp')
    ),
    []
  );
});

test('registerCursorUsageStopHook only claims entries with the exact installed shape', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const hooksPath = getCursorUserHooksPath(homeDir);
  mkdirSync(join(homeDir, '.cursor'), { recursive: true });
  // A user wrapper that mentions the script is NOT ours: a substring match
  // would delete it, the anchored shape match must preserve it.
  const userWrapper =
    "bash -c 'node /home/user/custom/record-cursor-usage.mjs && notify-send done'";
  writeFileSync(
    hooksPath,
    JSON.stringify({
      version: 1,
      hooks: { stop: [{ command: userWrapper }] },
    })
  );

  const pluginPath = join(homeDir, 'plugin');
  const result = registerCursorUsageStopHook({ userHome: homeDir, pluginPath });
  assert.equal(result.registered, true);

  const config = JSON.parse(readFileSync(hooksPath, 'utf8'));
  assert.equal(config.hooks.stop.length, 2);
  assert.equal(config.hooks.stop[0].command, userWrapper);
  assert.equal(config.hooks.stop[1].command.includes(pluginPath), true);
});

test('registerCursorUsageStopHook leaves the original file intact when the write fails', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const cursorDir = join(homeDir, '.cursor');
  const hooksPath = getCursorUserHooksPath(homeDir);
  mkdirSync(cursorDir, { recursive: true });
  const original = JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: '/opt/other-tool/hook.sh Stop' }] },
  });
  writeFileSync(hooksPath, original);

  // A read-only directory rejects the temp-file write; the merge must fail
  // closed without truncating or replacing hooks.json.
  chmodSync(cursorDir, 0o555);
  try {
    const result = registerCursorUsageStopHook({
      userHome: homeDir,
      pluginPath: join(homeDir, 'plugin'),
    });
    assert.equal(result.registered, false);
    assert.ok(result.reason);
  } finally {
    chmodSync(cursorDir, 0o755);
  }
  assert.equal(readFileSync(hooksPath, 'utf8'), original);
  assert.deepEqual(
    readdirSync(cursorDir).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('checkInstall and checkCursorUsageStopHook report the usage-hook state', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');

  installPlugin({ packageRoot: fixture.packageRoot, env: { HOME: homeDir } });
  const present = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(present.userHooks.registered, true);

  // Losing the hook entry is detectable without reinstalling.
  writeFileSync(
    getCursorUserHooksPath(homeDir),
    JSON.stringify({ version: 1, hooks: { stop: [] } })
  );
  const missing = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal(missing.userHooks.registered, false);
  assert.equal(missing.userHooks.reason, 'missing');

  writeFileSync(getCursorUserHooksPath(homeDir), '{not json');
  const unparsable = checkCursorUsageStopHook({
    userHome: homeDir,
    pluginPath: getPluginInstallPath(homeDir),
  });
  assert.equal(unparsable.registered, false);
  assert.equal(unparsable.reason, 'unparsable');
});

function createFixturePackage(homeDir, version, { manifestName = 'polygraph' } = {}) {
  const packageRoot = join(homeDir, 'package');
  mkdirSync(join(packageRoot, 'skills', 'polygraph'), { recursive: true });
  mkdirSync(join(packageRoot, 'hooks'), { recursive: true });
  writeFileSync(
    join(packageRoot, 'hooks', 'hooks.json'),
    JSON.stringify({ version: 1, hooks: { sessionStart: [] } })
  );
  writeFixturePackageJson(packageRoot, version);
  writeFileSync(
    join(packageRoot, 'plugin.json'),
    JSON.stringify({ name: manifestName, version, description: 'Test plugin' })
  );
  writeFileSync(
    join(packageRoot, 'skills', 'polygraph', 'SKILL.md'),
    '---\nname: polygraph\ndescription: test\n---\n\n# Test\n'
  );
  return { packageRoot };
}

function writeFixturePackageJson(packageRoot, version) {
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@polygraph/cursor-plugin', version })
  );
}
