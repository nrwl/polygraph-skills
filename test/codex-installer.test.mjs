import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkInstall,
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

test('installPlugin copies the package payload and populates marketplace — does not write config.toml', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const agentsPath = join(codexHome, 'agents');
  const marketplaceRoot = join(homeDir, '.polygraph', 'codex-marketplace');
  const marketplacePath = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const installedPluginPath = join(marketplaceRoot, 'plugins', 'polygraph');

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    register: fakeRegister(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.copied, true);
  assert.equal(result.pluginPath, installedPluginPath);
  assert.equal(existsSync(join(result.pluginPath, '.codex-plugin', 'plugin.json')), true);
  assert.equal(existsSync(join(result.pluginPath, 'skills', 'polygraph', 'SKILL.md')), true);
  assert.equal(existsSync(join(result.pluginPath, 'hooks', 'hooks.json')), true);
  assert.equal(
    existsSync(join(result.pluginPath, 'hooks', 'reinject-polygraph-context.mjs')),
    true
  );
  assert.equal(existsSync(join(result.pluginPath, 'agents', 'polygraph-init-subagent.toml')), true);

  // Agents must be installed to $CODEX_HOME/agents so they are accessible as subagents.
  assert.equal(existsSync(join(agentsPath, 'polygraph-init-subagent.toml')), true);
  assert.equal(existsSync(join(agentsPath, 'polygraph-delegate-subagent.toml')), true);
  assert.equal(result.agentsPath, agentsPath);
  assert.equal(result.agentsChanged, true);

  // The manifest we own must always be named polygraph-plugins: codex derives the
  // plugin id from it, and the id is a published contract.
  assert.equal(result.marketplacePath, marketplacePath);
  assert.equal(result.marketplaceName, 'polygraph-plugins');
  assert.equal(result.marketplaceRoot, marketplaceRoot);
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
  assert.equal(marketplace.name, 'polygraph-plugins');
  assert.deepEqual(marketplace.interface, { displayName: 'Polygraph Plugins' });
  assert.deepEqual(
    marketplace.plugins.find((p) => p.name === 'polygraph'),
    {
      name: 'polygraph',
      source: { source: 'local', path: './plugins/polygraph' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
    }
  );

  // Installer must NOT write config.toml — that is codex's job via `codex plugin add`.
  assert.equal(existsSync(join(codexHome, 'config.toml')), false,
    'installer must not write config.toml');

  // Result must not include config-related fields.
  assert.equal('configPath' in result, false);
  assert.equal('configChanged' in result, false);
  assert.equal('codexCachePath' in result, false);
});

// Regression: a pre-existing marketplace.json named something else must not rename our
// plugin. The installer used to adopt that name, publishing polygraph@<their-name> while
// every doc, hook and consumer asked for polygraph@polygraph-plugins.
test('installPlugin ignores a foreign shared marketplace and leaves it untouched', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const sharedPath = join(homeDir, '.agents', 'plugins', 'marketplace.json');
  const sharedBefore = {
    name: 'juris-marketplace',
    interface: { displayName: "Juri's plugins" },
    plugins: [
      { name: 'other-plugin', source: { source: 'local', path: './plugins/other-plugin' } },
    ],
  };
  mkdirSync(join(homeDir, '.agents', 'plugins'), { recursive: true });
  writeFileSync(sharedPath, `${JSON.stringify(sharedBefore, null, 2)}\n`);

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') },
    register: fakeRegister(),
  });

  assert.equal(result.marketplaceName, 'polygraph-plugins');
  assert.equal(
    JSON.parse(readFileSync(result.marketplacePath, 'utf8')).name,
    'polygraph-plugins',
    'our manifest must never adopt a foreign name'
  );
  assert.deepEqual(
    JSON.parse(readFileSync(sharedPath, 'utf8')),
    sharedBefore,
    'the shared marketplace must be byte-for-byte untouched'
  );
});

test('installPlugin registers the dedicated marketplace with codex', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const calls = [];
  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') },
    register: fakeRegister(calls),
  });

  // Without registration the dedicated root is invisible to codex: it only
  // auto-discovers the shared file, so `codex plugin add` would fail for everyone.
  assert.deepEqual(calls, [join(homeDir, '.polygraph', 'codex-marketplace')]);
  assert.equal(result.marketplaceRegistered, true);
});

test('installPlugin still materializes when codex is unavailable, and says so', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') },
    register: () => ({ registered: false, error: 'Could not run `codex`: not found' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.marketplaceRegistered, false);
  assert.match(result.marketplaceRegistrationError, /Could not run `codex`/);
  assert.equal(existsSync(result.pluginPath), true, 'payload is still materialized');
});

test('installPlugin removes a polygraph entry an older version left in the shared file', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const sharedPath = join(homeDir, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(join(homeDir, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    sharedPath,
    JSON.stringify(
      {
        name: 'juris-marketplace',
        plugins: [
          { name: 'other-plugin', source: { source: 'local', path: './plugins/other-plugin' } },
          { name: 'polygraph', source: { source: 'local', path: './.agents/plugins/polygraph' } },
        ],
      },
      null,
      2
    )
  );

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') },
    register: fakeRegister(),
  });

  assert.equal(result.legacyEntryRemoved, true);
  assert.equal(result.legacyMarketplaceRemoved, false);
  const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
  assert.equal(shared.name, 'juris-marketplace');
  assert.equal(shared.plugins.some((p) => p.name === 'polygraph'), false);
  assert.equal(shared.plugins.some((p) => p.name === 'other-plugin'), true,
    'unrelated plugins must survive the cleanup');
});

// Upgrade hazard: users installed before this change have a shared file WE wrote, named
// polygraph-plugins. Left in place it collides by name with the dedicated marketplace.
// Codex tolerates duplicate names and resolves them silently, so a stale payload could win.
test('installPlugin deletes the shared marketplace it authored itself', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const sharedPath = join(homeDir, '.agents', 'plugins', 'marketplace.json');
  mkdirSync(join(homeDir, '.agents', 'plugins'), { recursive: true });
  writeFileSync(
    sharedPath,
    JSON.stringify(
      {
        name: 'polygraph-plugins',
        plugins: [
          { name: 'polygraph', source: { source: 'local', path: './.agents/plugins/polygraph' } },
        ],
      },
      null,
      2
    )
  );

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') },
    register: fakeRegister(),
  });

  assert.equal(result.legacyEntryRemoved, true);
  assert.equal(result.legacyMarketplaceRemoved, true);
  assert.equal(existsSync(sharedPath), false,
    'a second marketplace named polygraph-plugins must not survive');
});

test('installPlugin is idempotent and checkInstall succeeds after install', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');

  const firstInstall = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    register: fakeRegister(),
  });
  assert.equal(firstInstall.pluginUpdated, false);
  assert.equal(firstInstall.previousVersion, null);

  const secondInstall = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    register: fakeRegister(),
  });

  assert.equal(secondInstall.copied, false);
  assert.equal(secondInstall.pluginUpdated, false);
  assert.equal(secondInstall.previousVersion, fixture.version);

  const check = checkInstall({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(check.ok, true);
  assert.equal(check.pluginInstalled, true);
  assert.equal(check.agentsInstalled, true);
  assert.equal(check.marketplaceConfigured, true);

  // checkInstall must not report config/cache fields.
  assert.equal('configEnabled' in check, false);
  assert.equal('codexCacheMirrored' in check, false);
  assert.equal('codexCachePath' in check, false);
});

test('installPlugin re-copies plugin payload when installed version differs', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = pluginPathFor(homeDir);

  installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    register: fakeRegister(),
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
    register: fakeRegister(),
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
  const installedPluginPath = pluginPathFor(homeDir);

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
        register: fakeRegister(),
      }),
    /incomplete or invalid/
  );

  const forced = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    force: true,
    register: fakeRegister(),
  });

  assert.equal(forced.overwritten, true);
});

test('installPlugin auto-updates when installed package.json is missing (no version readable)', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = pluginPathFor(homeDir);

  // An empty dir has no package.json → previousVersion=null → version mismatch → auto-update
  mkdirSync(installedPluginPath, { recursive: true });

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
    register: fakeRegister(),
  });

  assert.equal(result.copied, true);
  assert.equal(result.pluginUpdated, true);
  assert.equal(result.previousVersion, null);
});

/**
 * Stand-in for `codex plugin marketplace add` so tests stay hermetic. Pass an array to
 * capture the roots it was asked to register.
 */
function fakeRegister(calls = []) {
  return ({ marketplaceRoot }) => {
    calls.push(marketplaceRoot);
    return { registered: true };
  };
}

function marketplaceRootFor(homeDir) {
  return join(homeDir, '.polygraph', 'codex-marketplace');
}

function pluginPathFor(homeDir) {
  return join(marketplaceRootFor(homeDir), 'plugins', 'polygraph');
}

function createFixturePackage(baseDir = tmpdir(), version = '1.2.3') {
  const packageRoot = mkdtempSync(join(baseDir, 'polygraph-package-'));

  mkdirSync(join(packageRoot, '.codex-plugin'), { recursive: true });
  mkdirSync(join(packageRoot, 'skills', 'polygraph'), { recursive: true });
  mkdirSync(join(packageRoot, 'agents'), { recursive: true });
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(packageRoot, 'lib'), { recursive: true });
  mkdirSync(join(packageRoot, 'hooks'), { recursive: true });

  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@polygraph/codex-plugin',
        version,
        files: ['.codex-plugin/', 'skills/', 'agents/', 'hooks/', '.mcp.json', 'README.md', 'bin/', 'lib/'],
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
  writeFileSync(
    join(packageRoot, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [] } })
  );
  writeFileSync(
    join(packageRoot, 'hooks', 'reinject-polygraph-context.mjs'),
    '// fixture hook\n'
  );
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
