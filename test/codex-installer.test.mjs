import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

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
  const firstConfig = readFileSync(configPath, 'utf8');

  const secondInstall = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(secondInstall.copied, false);
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

test('installPlugin refuses to reuse an invalid target without --force', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const fixture = createFixturePackage(homeDir);
  const codexHome = join(homeDir, '.codex');
  const installedPluginPath = join(homeDir, '.agents', 'plugins', 'polygraph');

  mkdirSync(installedPluginPath, { recursive: true });

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

function createFixturePackage(baseDir = tmpdir()) {
  const packageRoot = mkdtempSync(join(baseDir, 'polygraph-package-'));
  const version = '1.2.3';

  mkdirSync(join(packageRoot, '.codex-plugin'), { recursive: true });
  mkdirSync(join(packageRoot, 'skills', 'polygraph'), { recursive: true });
  mkdirSync(join(packageRoot, 'agents'), { recursive: true });
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(packageRoot, 'lib'), { recursive: true });

  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'polygraph-codex-plugin',
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
