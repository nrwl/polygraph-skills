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
      warnOnMissingUsageHook(result.userHooks);
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
    warnOnMissingUsageHook(result.userHooks);
  }

  if (command === "check" && !result.ok) {
    process.exitCode = 1;
  }
}

/**
 * The payload can materialize while the user-scope stop hook fails to
 * register (unparsable or unwritable hooks.json). That is a partial install:
 * cursor token usage from interactive sessions goes unrecorded until it is
 * fixed, so say so instead of reporting plain success. Exit code stays 0:
 * the payload itself is usable and the Polygraph CLI must not treat the
 * launch-path install as failed.
 */
function warnOnMissingUsageHook(userHooks) {
  if (!userHooks || userHooks.registered) return;
  const detail =
    userHooks.reason === "unparsable"
      ? `${userHooks.hooksPath} could not be parsed as JSON`
      : userHooks.reason === "missing"
        ? `no entry found in ${userHooks.hooksPath}`
        : `${userHooks.hooksPath}: ${userHooks.reason}`;
  console.error(
    `Warning: the token-usage stop hook is not registered (${detail}). ` +
      "Cursor token usage from interactive sessions will not be recorded. " +
      "Fix the file, then rerun: npx @polygraph/cursor-plugin install",
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`polygraph-cursor-plugin failed: ${message}`);
  process.exitCode = 1;
});
