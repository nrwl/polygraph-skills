#!/usr/bin/env node

import {
  checkInstall,
  getPackageRootFromMetaUrl,
  installPlugin,
} from '../lib/installer.mjs';

const usage = `Usage:
  npx @polygraph/codex-plugin
  npx @polygraph/codex-plugin install [--force] [--json]
  npx @polygraph/codex-plugin check [--json]

The install command materializes the plugin payload into the marketplace Polygraph
owns (~/.polygraph/codex-marketplace) and registers that marketplace with codex.
It does not write to the shared ~/.agents/plugins/marketplace.json. After running
install, run:

  codex plugin add polygraph@polygraph-plugins

to have codex register and enable the plugin in its own config.`;

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
      console.log(`Polygraph Codex plugin is materialized.`);
      console.log(`Plugin path: ${result.pluginPath}`);
      console.log(`Agents: ${result.agentsPath}`);
      console.log(`Marketplace: ${result.marketplacePath}`);
    } else {
      const pluginState = result.pluginInstalled
        ? 'plugin files present'
        : 'plugin files not present';
      const agentsState = result.agentsInstalled
        ? 'agents installed'
        : 'agents not installed';
      const marketplaceState = result.marketplaceConfigured
        ? `plugin published from the ${result.marketplaceName} marketplace`
        : `plugin not published from the ${result.marketplaceName} marketplace`;
      const legacyState = result.legacyMarketplacePresent
        ? '; a stale entry remains in ~/.agents/plugins/marketplace.json (re-run install to clear it)'
        : '';
      console.error(
        `Polygraph Codex plugin check failed: ${pluginState}; ${agentsState}; ${marketplaceState}${legacyState}.`
      );
    }
  } else {
    console.log(`Materialized Polygraph Codex plugin ${result.version}.`);
    console.log(`Plugin path: ${result.pluginPath}`);
    console.log(`Agents: ${result.agentsPath}`);
    console.log(`Marketplace: ${result.marketplaceName} (${result.marketplaceRoot})`);
    if (result.legacyEntryRemoved) {
      console.log(
        result.legacyMarketplaceRemoved
          ? 'Removed the obsolete ~/.agents/plugins/marketplace.json written by an earlier version.'
          : 'Removed the obsolete polygraph entry from ~/.agents/plugins/marketplace.json; your other plugins were left untouched.'
      );
    }
    if (result.marketplaceRegistered) {
      console.log(`Next step: codex plugin add ${result.plugin}`);
    } else {
      console.warn(`Warning: ${result.marketplaceRegistrationError}`);
      console.warn(
        `Then run: codex plugin add ${result.plugin}`
      );
    }
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
