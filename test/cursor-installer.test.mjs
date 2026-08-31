import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkInstall,
  getPluginInstallPath,
  installPlugin,
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

test('installPlugin never touches shared Cursor user settings', () => {
  // Cursor token accounting is intentionally unsupported, so there is no
  // user-scope hook to register: the installer materializes the payload and
  // nothing else. ~/.cursor must not even be created.
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-home-'));
  const fixture = createFixturePackage(homeDir, '1.2.3');

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });

  assert.equal(result.ok, true);
  assert.equal('userHooks' in result, false);
  assert.equal(existsSync(join(homeDir, '.cursor')), false);

  const check = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir },
  });
  assert.equal('userHooks' in check, false);
  assert.equal(existsSync(join(homeDir, '.cursor')), false);
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
