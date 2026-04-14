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
  const fixture = createFixturePackage();
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const codexHome = join(homeDir, '.codex');
  const configPath = join(codexHome, 'config.toml');

  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    configPath,
    ['default_model = "gpt-5"', '', '[plugins."other@vendor"]', 'enabled = false', ''].join('\n')
  );

  const result = installPlugin({
    packageRoot: fixture.packageRoot,
    env: { HOME: homeDir, CODEX_HOME: codexHome },
  });

  assert.equal(result.ok, true);
  assert.equal(result.copied, true);
  assert.equal(
    existsSync(join(result.installPath, '.codex-plugin', 'plugin.json')),
    true
  );
  assert.equal(existsSync(join(result.installPath, 'skills', 'polygraph', 'SKILL.md')), true);

  const config = parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.default_model, 'gpt-5');
  assert.equal(config.plugins['other@vendor'].enabled, false);
  assert.equal(config.plugins['polygraph@polygraph'].enabled, true);
});

test('installPlugin is idempotent and checkInstall succeeds after install', () => {
  const fixture = createFixturePackage();
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
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
  assert.deepEqual(check.installedVersions, [firstInstall.version]);
});

test('installPlugin refuses to reuse an invalid target without --force', () => {
  const fixture = createFixturePackage();
  const homeDir = mkdtempSync(join(tmpdir(), 'polygraph-home-'));
  const codexHome = join(homeDir, '.codex');
  const installPath = join(
    codexHome,
    'plugins',
    'cache',
    'polygraph',
    'polygraph',
    fixture.version
  );

  mkdirSync(installPath, { recursive: true });

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

function createFixturePackage() {
  const packageRoot = mkdtempSync(join(tmpdir(), 'polygraph-package-'));
  const version = '1.2.3';

  mkdirSync(join(packageRoot, '.codex-plugin'), { recursive: true });
  mkdirSync(join(packageRoot, 'skills', 'polygraph'), { recursive: true });
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(packageRoot, 'lib'), { recursive: true });

  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'polygraph-codex-plugin',
        version,
        files: ['.codex-plugin/', 'skills/', '.mcp.json', 'README.md', 'bin/', 'lib/'],
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

  return { packageRoot, version };
}
