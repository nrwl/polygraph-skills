import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "polygraph";

/**
 * Payload entries copied from the published package into the install dir.
 * `bin/` stays behind: it is the installer itself, and `cursor-agent
 * --plugin-dir` treats every file in the directory as plugin content.
 */
const PAYLOAD_ENTRIES = [
  "plugin.json",
  "skills",
  "agents",
  "hooks",
  "package.json",
  "README.md",
  "LICENSE",
];

export function getPackageRootFromMetaUrl(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

export function resolveUserHome(env = process.env) {
  const userHome = env.HOME?.trim() || homedir();
  return resolve(expandHome(userHome, env));
}

/**
 * Where the payload lands: a directory Polygraph owns outright, mirroring the
 * codex marketplace's placement under ~/.polygraph. Cursor has no install
 * registry to publish into for the CLI; the Polygraph launcher passes this
 * path via `cursor-agent --plugin-dir`, and manual users can do the same.
 */
export function getPluginInstallPath(userHome) {
  return join(userHome, ".polygraph", "plugins", "cursor", PLUGIN_NAME);
}

function expandHome(value, env) {
  if (value === "~" || value.startsWith("~/")) {
    const home = env.HOME?.trim() || homedir();
    return join(home, value.slice(1));
  }
  return value;
}

export function loadPackageMetadata(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  const pluginManifestPath = join(packageRoot, "plugin.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing package.json at ${packageJsonPath}`);
  }

  if (!existsSync(pluginManifestPath)) {
    throw new Error(`Missing Cursor plugin manifest at ${pluginManifestPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));

  if (pluginManifest.name !== PLUGIN_NAME) {
    throw new Error(
      `Expected plugin.json name to be "${PLUGIN_NAME}", received "${pluginManifest.name ?? "undefined"}"`,
    );
  }

  if (!packageJson.version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }

  return { version: packageJson.version };
}

function readInstalledVersion(pluginPath) {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pluginPath, "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function isInstallComplete(pluginPath) {
  return (
    existsSync(join(pluginPath, "plugin.json")) &&
    existsSync(join(pluginPath, "skills"))
  );
}

/**
 * Materialize the plugin payload to ~/.polygraph/plugins/cursor/polygraph.
 *
 * Refresh-aware: a complete install of the same version is a no-op unless
 * `force` is set; a different (or unreadable) version is replaced. The copy
 * is recreate-then-copy rather than merge so a removed payload file never
 * lingers across versions.
 */
export function installPlugin({ packageRoot, env = process.env, force = false }) {
  const { version } = loadPackageMetadata(packageRoot);
  const userHome = resolveUserHome(env);
  const pluginPath = getPluginInstallPath(userHome);

  const installAlreadyPresent = existsSync(pluginPath);
  const previousVersion = installAlreadyPresent
    ? readInstalledVersion(pluginPath)
    : null;
  const complete = installAlreadyPresent && isInstallComplete(pluginPath);
  const versionMismatch = installAlreadyPresent && previousVersion !== version;
  const shouldCopy = !installAlreadyPresent || force || versionMismatch || !complete;

  if (shouldCopy) {
    rmSync(pluginPath, { recursive: true, force: true });
    mkdirSync(pluginPath, { recursive: true });
    for (const entry of PAYLOAD_ENTRIES) {
      const src = join(packageRoot, entry);
      if (existsSync(src)) {
        cpSync(src, join(pluginPath, entry), { recursive: true });
      }
    }
  }

  const userHooks = registerCursorUsageStopHook({ userHome, pluginPath });

  return {
    ok: true,
    action: "install",
    plugin: PLUGIN_NAME,
    version,
    previousVersion,
    pluginPath,
    copied: shouldCopy,
    overwritten: installAlreadyPresent && force,
    pluginUpdated: installAlreadyPresent && versionMismatch && !force,
    userHooks,
  };
}

const USAGE_HOOK_SCRIPT = "record-cursor-usage.mjs";

export function getCursorUserHooksPath(userHome) {
  return join(userHome, ".cursor", "hooks.json");
}

/**
 * Merge the usage-capture `stop` entry into the user-scope
 * `~/.cursor/hooks.json`. This entry cannot ride the plugin payload alone:
 * cursor dispatches only a subset of hook events (e.g. sessionStart) from
 * `--plugin-dir` plugins and `stop` is not among them (live-verified on
 * 2026.08.25-3e8eec8), while user-scope `stop` fires per turn with the
 * usage counters Polygraph's token-cost reporting reads back.
 *
 * The merge is additive and idempotent: entries owned by other tools are
 * never touched, a stale entry pointing at an old install path is replaced,
 * and an unparsable file is left untouched (registration is skipped rather
 * than clobbering user configuration). Re-running install self-heals the
 * entry.
 */
export function registerCursorUsageStopHook({ userHome, pluginPath }) {
  const hooksPath = getCursorUserHooksPath(userHome);
  const command = `node "${join(pluginPath, "hooks", USAGE_HOOK_SCRIPT)}"`;

  let config = { version: 1, hooks: {} };
  if (existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { registered: false, reason: "unparsable", hooksPath };
      }
      config = parsed;
    } catch {
      return { registered: false, reason: "unparsable", hooksPath };
    }
  }

  if (
    !config.hooks ||
    typeof config.hooks !== "object" ||
    Array.isArray(config.hooks)
  ) {
    config.hooks = {};
  }
  const stop = Array.isArray(config.hooks.stop) ? config.hooks.stop : [];

  const isOurs = (entry) =>
    entry &&
    typeof entry === "object" &&
    typeof entry.command === "string" &&
    entry.command.includes(USAGE_HOOK_SCRIPT);
  if (stop.some((entry) => isOurs(entry) && entry.command === command)) {
    return { registered: true, changed: false, hooksPath };
  }

  const next = stop.filter((entry) => !isOurs(entry));
  next.push({ command });
  config.hooks.stop = next;
  if (config.version === undefined) config.version = 1;

  try {
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, `${JSON.stringify(config, null, 2)}\n`);
    return { registered: true, changed: true, hooksPath };
  } catch (error) {
    return {
      registered: false,
      reason: error instanceof Error ? error.message : String(error),
      hooksPath,
    };
  }
}

/**
 * Diagnosis-only probe: reports whether a complete payload is materialized
 * and which version it carries. Never writes.
 */
export function checkInstall({ packageRoot = null, env = process.env } = {}) {
  const userHome = resolveUserHome(env);
  const pluginPath = getPluginInstallPath(userHome);
  const installed = existsSync(pluginPath) && isInstallComplete(pluginPath);
  const installedVersion = installed ? readInstalledVersion(pluginPath) : null;
  const packageVersion = packageRoot
    ? loadPackageMetadata(packageRoot).version
    : null;

  return {
    ok: installed,
    plugin: PLUGIN_NAME,
    pluginPath,
    installed,
    installedVersion,
    packageVersion,
    upToDate:
      installed && packageVersion !== null
        ? installedVersion === packageVersion
        : null,
  };
}
