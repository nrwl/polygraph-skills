import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
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
  };
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
