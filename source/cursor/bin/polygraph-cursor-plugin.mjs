#!/usr/bin/env node

import {
  checkInstall,
  getPackageRootFromMetaUrl,
  installPlugin,
} from "../lib/installer.mjs";

const usage = `Usage:
  npx @polygraph/cursor-plugin
  npx @polygraph/cursor-plugin install [--force] [--json]
  npx @polygraph/cursor-plugin check [--json]

The install command materializes the plugin payload to a directory the
Polygraph CLI passes to cursor-agent via --plugin-dir on every launch.
Manual runs can load it the same way:

  cursor-agent --plugin-dir <plugin path>`;

async function main() {
  const args = process.argv.slice(2);
  let command = "install";
  let json = false;
  let force = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "install" || arg === "check") {
      command = arg;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${usage}`);
  }

  if (command === "check" && force) {
    throw new Error("--force is only supported with the install command");
  }

  const packageRoot = getPackageRootFromMetaUrl(import.meta.url);
  const result =
    command === "check"
      ? checkInstall({ packageRoot, env: process.env })
      : installPlugin({ packageRoot, env: process.env, force });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "check") {
    if (result.ok) {
      console.log("Polygraph Cursor plugin is materialized.");
      console.log(`Plugin path: ${result.pluginPath}`);
      console.log(`Installed version: ${result.installedVersion ?? "unknown"}`);
    } else {
      console.error(
        `Polygraph Cursor plugin check failed: no complete payload at ${result.pluginPath}.`,
      );
    }
  } else {
    console.log(`Materialized Polygraph Cursor plugin ${result.version}.`);
    console.log(`Plugin path: ${result.pluginPath}`);
    console.log(
      "The Polygraph CLI loads it automatically; manual runs: " +
        `cursor-agent --plugin-dir ${result.pluginPath}`,
    );
  }

  if (command === "check" && !result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`polygraph-cursor-plugin failed: ${message}`);
  process.exitCode = 1;
});
