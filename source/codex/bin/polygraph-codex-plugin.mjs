#!/usr/bin/env node

import {
  checkInstall,
  getPackageRootFromMetaUrl,
  installPlugin,
} from '../lib/installer.mjs';

const usage = `Usage:
  npx polygraph-codex-plugin
  npx polygraph-codex-plugin install [--force] [--json]
  npx polygraph-codex-plugin check [--json]`;

async function main() {
  const args = process.argv.slice(2);
  let command = 'install';
  let json = false;
  let force = false;

  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--force') {
      force = true;
      continue;
    }

    if (arg === 'install' || arg === 'check') {
      command = arg;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log(usage);
      return;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
  }

  if (command === 'check' && force) {
    throw new Error('--force is only supported with the install command');
  }

  const packageRoot = getPackageRootFromMetaUrl(import.meta.url);
  const result =
    command === 'check'
      ? checkInstall({ packageRoot, env: process.env })
      : installPlugin({ packageRoot, env: process.env, force });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'check') {
    if (result.ok) {
      console.log(`Polygraph Codex plugin is enabled.`);
      console.log(`Cache root: ${result.cacheRoot}`);
      console.log(`Installed versions: ${result.installedVersions.join(', ')}`);
      console.log(`Config: ${result.configPath}`);
    } else {
      const installState =
        result.installedVersions.length > 0
          ? `found installed version(s): ${result.installedVersions.join(', ')}`
          : 'no installed plugin versions found';
      const configState = result.configEnabled
        ? 'plugin enabled in config'
        : 'plugin not enabled in config';
      console.error(`Polygraph Codex plugin check failed: ${installState}; ${configState}.`);
    }
  } else {
    console.log(`Installed Polygraph Codex plugin ${result.version}.`);
    console.log(`Cache install: ${result.installPath}`);
    console.log(`Config: ${result.configPath}`);
  }

  if (command === 'check' && !result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`polygraph-codex-plugin failed: ${message}`);
  process.exitCode = 1;
});
