import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import {
  checkInstall,
  getCacheRoot,
  installPlugin,
  resolveCodexHome,
} from '../source/codex/lib/installer.mjs';

test('resolveCodexHome respects CODEX_HOME and falls back to HOME', () => {
  const home = '/tmp/example-home';
  assert.equal(
    resolveCodexHome({ HOME: home, CODEX_HOME: '~/custom-codex-home' }),
    join(home, 'custom-codex-home')
  );
  assert.equal(resolveCodexHome({ HOME: home }), join(home, '.codex'));
});

test('installPlugin copies the package payload and preserves unrelated config', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const configPath = join(codexHome, 'config.toml');
  const agentsPath = join(codexHome, 'agents');
  const marketplacePath = join(homeDir, '.agents', 'plugins', 'marketplace.json');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    configPath,
    ['default_model = "gpt-5"', '', '[plugins."other@vendor"]', 'enabled = false', ''].join('\n')
  );
  mkdirSync(join(homeDir, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    marketplacePath,
    JSON.stringify(
      {
        name: 'existing-marketplace',
        plugins: [
          {
            name: 'other-plugin',
            source: {
              source: 'local',
              path: './plugins/other-plugin',
            },
          },
        ],
      },
      null,
      2
    )
  );

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(result.ok, true);
  assert.equal(result.copied, true);
  assert.equal(result.pluginPath, installedPluginPath);
  assert.equal(existsSync(join(result.pluginPath, '.codex-plugin', 'plugin.json')), true);
  assert.equal(existsSync(join(result.pluginPath, 'skills', 'polygraph', 'SKILL.md')), true);
  assert.equal(existsSync(join(result.pluginPath, 'agents', 'polygraph-init-subagent.toml')), true);
  assert.equal(existsSync(join(agentsPath, 'polygraph-init-subagent.toml')), true);
  assert.equal(existsSync(join(agentsPath, 'polygraph-delegate-subagent.toml')), true);
  assert.equal(result.agentsPath, agentsPath);
  assert.equal(result.agentsChanged, true);
  assert.equal(result.marketplacePath, marketplacePath);

  const config = parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.default_model, 'gpt-5');
  assert.equal(config.plugins['other@vendor'].enabled, false);
  assert.equal(config.plugins['polygraph@polygraph-plugins'].enabled, true);

  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
  assert.equal(marketplace.name, 'existing-marketplace');
  assert.deepEqual(marketplace.interface, { displayName: 'Polygraph Plugins' });
  assert.equal(marketplace.plugins.some((plugin) => plugin.name === 'other-plugin'), true);
  assert.deepEqual(
    marketplace.plugins.find((plugin) => plugin.name === 'polygraph'),
    {
      name: 'polygraph',
      source: {
        source: 'local',
        path: './.agents/plugins/polygraph',
      },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: 'Productivity',
    }
  );
});

test('installPlugin is idempotent and checkInstall succeeds after install', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const configPath = join(codexHome, 'config.toml');

  const firstInstall = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });
  assert.equal(firstInstall.pluginUpdated, false);
  assert.equal(firstInstall.previousVersion, null);

  const firstConfig = readFileSync(configPath, 'utf8');

  const secondInstall = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(secondInstall.copied, false);
  assert.equal(secondInstall.pluginUpdated, false);
  assert.equal(secondInstall.previousVersion, fixture.version);
  assert.equal(readFileSync(configPath, 'utf8'), firstConfig);

  const check = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(check.ok, true);
  assert.equal(check.pluginInstalled, true);
  assert.equal(check.agentsInstalled, true);
  assert.equal(check.marketplaceConfigured, true);
});

test('installPlugin re-copies plugin payload when installed version differs', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  // Simulate a stale install: overwrite the installed package.json with an older version
  const staleVersion = '1.2.2';
  writeFileSync(
    join(installedPluginPath, 'package.json'),
    JSON.stringify({ name: '@polygraph/codex-plugin', version: staleVersion }, null, 2)
  );
  // Also corrupt a skill file to confirm it gets restored
  writeFileSync(join(installedPluginPath, 'skills', 'polygraph', 'SKILL.md'), '# stale\n');

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(result.copied, true);
  assert.equal(result.pluginUpdated, true);
  assert.equal(result.previousVersion, staleVersion);

  // Verify the skill file was restored to the source version
  const restoredSkill = readFileSync(
    join(installedPluginPath, 'skills', 'polygraph', 'SKILL.md'),
    'utf8'
  );
  assert.equal(restoredSkill, '# Polygraph\n');

  // Verify the installed package.json reflects the source version
  const installedPkg = JSON.parse(
    readFileSync(join(installedPluginPath, 'package.json'), 'utf8')
  );
  assert.equal(installedPkg.version, fixture.version);
});

test('installPlugin refuses to reuse an invalid target without --force when version matches', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  // Simulate a dir with the correct version but missing required plugin files
  mkdirSync(installedPluginPath, { recursive: true });
  writeFileSync(
    join(installedPluginPath, 'package.json'),
    JSON.stringify({ name: '@polygraph/codex-plugin', version: fixture.version }, null, 2)
  );

  assert.throws(
    () =>
      installPlugin({
        packageRoot: fixture.packageRoot,
        env: { HOME: homeDir, CODEX_HOME: codexHome },
      }),
    /incomplete or invalid/
  );

  const forced = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    force: true,
  });

  assert.equal(forced.overwritten, true);
});

test('installPlugin auto-updates when installed package.json is missing (no version readable)', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  // An empty dir has no package.json → previousVersion=null → version mismatch → auto-update
  mkdirSync(installedPluginPath, { recursive: true });

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(result.copied, true);
  assert.equal(result.pluginUpdated, true);
  assert.equal(result.previousVersion, null);
});

// ---------------------------------------------------------------------------
// Codex cache mirror tests (workaround for openai/codex#21138)
// ---------------------------------------------------------------------------

test('installPlugin mirrors plugin payload into Codex cache when codexHome exists', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  const expectedCachePath = getCacheRoot(codexHome, fixture.version);
  assert.equal(result.codexCachePath, expectedCachePath);
  assert.equal(existsSync(expectedCachePath), true);

  // Verify the versioned dir was written under the correct marketplace/plugin path.
  // The parent should be <codexHome>/plugins/cache/polygraph-plugins/polygraph/.
  const cacheRoot = getCacheRoot(codexHome);
  assert.deepEqual(readdirSync(cacheRoot), [fixture.version]);
});

test('installPlugin cache files are byte-identical to live install files', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  // Walk the cache dir and compare every file to the live install.
  function assertDirsMatch(liveDir, cacheDir) {
    const liveEntries = readdirSync(liveDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    const cacheEntries = readdirSync(cacheDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    assert.equal(liveEntries.length, cacheEntries.length, `Entry count mismatch in ${liveDir}`);
    for (let i = 0; i < liveEntries.length; i++) {
      assert.equal(liveEntries[i].name, cacheEntries[i].name);
      if (liveEntries[i].isDirectory()) {
        assertDirsMatch(join(liveDir, liveEntries[i].name), join(cacheDir, cacheEntries[i].name));
      } else {
        const liveContent = readFileSync(join(liveDir, liveEntries[i].name));
        const cacheContent = readFileSync(join(cacheDir, cacheEntries[i].name));
        assert.equal(liveContent.equals(cacheContent), true, `Content mismatch: ${liveEntries[i].name}`);
      }
    }
  }

  assertDirsMatch(result.pluginPath, result.codexCachePath);
});

test('installPlugin removes stale version dirs before writing new cache', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');

  // First install at version 1.2.3
  installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });
  const oldCachePath = getCacheRoot(codexHome, fixture.version);
  assert.equal(existsSync(oldCachePath), true);

  // Simulate a version bump by creating a second fixture at 2.0.0
  const newFixture = createFixturePackage(homeDir, '2.0.0');

  const result = installPlugin({
    packageRoot: newFixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  // Old version dir must be gone; only new version dir should exist.
  assert.equal(existsSync(oldCachePath), false, 'Stale 1.2.3 cache dir should be removed');
  assert.equal(result.codexCachePath, getCacheRoot(codexHome, '2.0.0'));
  assert.equal(existsSync(result.codexCachePath), true);
  const cacheRoot = getCacheRoot(codexHome);
  assert.deepEqual(readdirSync(cacheRoot), ['2.0.0']);
});

test('checkInstall reports codexCacheMirrored null when codexHome does not exist', () => {
  // When codexHome is a path that has never been created, checkInstall must
  // return codexCachePath: null and codexCacheMirrored: null (not an error).
  // Note: installPlugin always creates codexHome as a side-effect of writing
  // config.toml, so this scenario is only reachable via checkInstall directly.
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex-never-created');

  const check = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(check.codexCachePath, null);
  assert.equal(check.codexCacheMirrored, null);
});

test('checkInstall reports codexCacheMirrored true after install and false when cache is stale', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  const checkAfterInstall = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });
  assert.equal(checkAfterInstall.codexCacheMirrored, true);
  assert.equal(checkAfterInstall.codexCachePath, getCacheRoot(codexHome, fixture.version));

  // Corrupt a file in the live install dir to make cache diverge from live.
  writeFileSync(join(installedPluginPath, 'skills', 'polygraph', 'SKILL.md'), '# stale-live\n');

  const checkAfterCorrupt = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });
  assert.equal(checkAfterCorrupt.codexCacheMirrored, false);
});

test('installPlugin mirrors cache even when the main install is a no-op (idempotent version)', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  // First install
  const first = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });
  assert.equal(first.copied, true);
  assert.notEqual(first.codexCachePath, null);

  // Corrupt the cache directly to prove a second no-op install still refreshes it.
  writeFileSync(join(first.codexCachePath, 'README.md'), '# stale-cache\n');

  // Second install: main copy skipped (same version), but cache must be refreshed.
  const second = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });
  assert.equal(second.copied, false, 'Main copy should be a no-op on second install');
  assert.equal(second.codexCachePath, first.codexCachePath);

  // Cache should be fresh again — content matches live install.
  const liveContent = readFileSync(join(installedPluginPath, 'README.md'), 'utf8');
  const cacheContent = readFileSync(join(second.codexCachePath, 'README.md'), 'utf8');
  assert.equal(cacheContent, liveContent);
});

function createFixturePackage(baseDir = tmpdir(), version = '1.2.3') {
  const packageRoot = mkdtempSync(join(baseDir, 'polygraph-package-'));

  mkdirSync(join(packageRoot, '.codex-plugin'), { recursive: true });
  mkdirSync(join(packageRoot, 'skills', 'polygraph'), { recursive: true });
  mkdirSync(join(packageRoot, 'agents'), { recursive: true });
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(packageRoot, 'lib'), { recursive: true });

  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@polygraph/codex-plugin',
        version,
        files: ['.codex-plugin/', 'skills/', 'agents/', '.mcp.json', 'README.md', 'bin/', 'lib/'],
        bin: {
          'polygraph-codex-plugin': './bin/polygraph-codex-plugin.mjs',
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    join(packageRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'polygraph', version }, null, 2)
  );
  writeFileSync(join(packageRoot, '.mcp.json'), JSON.stringify({}));
  writeFileSync(join(packageRoot, 'README.md'), '# Fixture\n');
  writeFileSync(join(packageRoot, 'bin', 'polygraph-codex-plugin.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(packageRoot, 'lib', 'installer.mjs'), 'export {};\n');
  writeFileSync(join(packageRoot, 'skills', 'polygraph', 'SKILL.md'), '# Polygraph\n');
  writeFileSync(
    join(packageRoot, 'agents', 'polygraph-init-subagent.toml'),
    'name = "polygraph-init-subagent"\ndescription = "Init"\ndeveloper_instructions = "Init"\n'
  );
  writeFileSync(
    join(packageRoot, 'agents', 'polygraph-delegate-subagent.toml'),
    'name = "polygraph-delegate-subagent"\ndescription = "Delegate"\ndeveloper_instructions = "Delegate"\n'
  );

  return { packageRoot, version };
}
