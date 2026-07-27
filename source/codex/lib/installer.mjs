import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "polygraph";
const PLUGIN_ID = "polygraph@polygraph-plugins";
const MARKETPLACE_NAME = "polygraph-plugins";
const MARKETPLACE_DISPLAY_NAME = "Polygraph Plugins";

export function getPackageRootFromMetaUrl(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

export function resolveCodexHome(env = process.env) {
  const configuredHome = env.CODEX_HOME?.trim();
  if (configuredHome) {
    return resolve(expandHome(configuredHome, env));
  }

  const userHome = env.HOME?.trim() || homedir();
  return join(resolve(expandHome(userHome, env)), ".codex");
}

export function getAgentsPath(codexHome) {
  return join(codexHome, "agents");
}

export function resolveUserHome(env = process.env) {
  const userHome = env.HOME?.trim() || homedir();
  return resolve(expandHome(userHome, env));
}

/**
 * Root of the marketplace Polygraph owns outright.
 *
 * Polygraph must not publish into ~/.agents/plugins/marketplace.json: that file is
 * shared, codex-discovered, and may already have been created by another tool. Codex
 * derives plugin ids from the manifest's `name`, so adopting a foreign name there
 * silently republishes this plugin as polygraph@<their-name> and every documented
 * `codex plugin add polygraph@polygraph-plugins` fails.
 */
export function getMarketplaceRoot(userHome) {
  return join(userHome, ".polygraph", "codex-marketplace");
}

export function getMarketplacePath(marketplaceRoot) {
  return join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
}

export function getPluginInstallPath(marketplaceRoot) {
  return join(marketplaceRoot, "plugins", PLUGIN_NAME);
}

/** The shared file older versions published into. Only ever cleaned up, never written. */
export function getLegacyMarketplacePath(userHome) {
  return join(userHome, ".agents", "plugins", "marketplace.json");
}

export function getLegacyPluginInstallPath(userHome) {
  return join(userHome, ".agents", "plugins", PLUGIN_NAME);
}

export function loadPackageMetadata(packageRoot) {
  const packageJsonPath = join(packageRoot, "package.json");
  const pluginManifestPath = join(packageRoot, ".codex-plugin", "plugin.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing package.json at ${packageJsonPath}`);
  }

  if (!existsSync(pluginManifestPath)) {
    throw new Error(`Missing Codex plugin manifest at ${pluginManifestPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));

  if (pluginManifest.name !== PLUGIN_NAME) {
    throw new Error(
      `Expected .codex-plugin/plugin.json name to be "${PLUGIN_NAME}", received "${pluginManifest.name ?? "undefined"}"`,
    );
  }

  if (!packageJson.version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }

  if (
    pluginManifest.version &&
    pluginManifest.version !== packageJson.version
  ) {
    throw new Error(
      `Package version mismatch: package.json has "${packageJson.version}" but plugin manifest has "${pluginManifest.version}"`,
    );
  }

  return {
    packageJson,
    pluginManifest,
    version: packageJson.version,
  };
}

/**
 * Materialize the plugin payload so codex's official `codex plugin add` can pick it up.
 *
 * This command:
 *   a. Copies the plugin payload to <marketplaceRoot>/plugins/polygraph (version-refresh aware).
 *   b. Writes the marketplace manifest Polygraph owns at
 *      <marketplaceRoot>/.agents/plugins/marketplace.json, always named `polygraph-plugins`.
 *   c. Registers that root with codex (`codex plugin marketplace add`), which is idempotent.
 *   d. Removes any entry an older version published into the shared
 *      ~/.agents/plugins/marketplace.json, so the name cannot resolve ambiguously.
 *   e. Copies agents/*.toml to $CODEX_HOME/agents (official `codex plugin add` does
 *      not surface plugin agents; this step keeps them available).
 *
 * It does NOT touch ~/.codex/config.toml — that is codex's job when the consumer
 * subsequently runs `codex plugin add polygraph@polygraph-plugins`.
 *
 * Step (c) exists because codex only auto-discovers the *shared* file. A dedicated root
 * is invisible until registered, so registering here keeps `codex plugin add
 * polygraph@polygraph-plugins` working for consumers that predate this change.
 */
export function installPlugin({
  packageRoot,
  env = process.env,
  force = false,
  // Injectable so tests do not have to shell out to a real codex binary.
  register = registerMarketplace,
} = {}) {
  if (!packageRoot) {
    throw new Error("packageRoot is required");
  }

  const { packageJson, version } = loadPackageMetadata(packageRoot);
  const codexHome = resolveCodexHome(env);
  const userHome = resolveUserHome(env);
  const agentsPath = getAgentsPath(codexHome);
  const marketplaceRoot = getMarketplaceRoot(userHome);
  const marketplacePath = getMarketplacePath(marketplaceRoot);
  const pluginPath = getPluginInstallPath(marketplaceRoot);
  const installAlreadyPresent = existsSync(pluginPath);

  let previousVersion = null;
  if (installAlreadyPresent) {
    try {
      const installedPkg = JSON.parse(
        readFileSync(join(pluginPath, "package.json"), "utf8"),
      );
      previousVersion = installedPkg.version ?? null;
    } catch {
      // unreadable - treat as missing
    }
  }
  const versionMismatch = installAlreadyPresent && previousVersion !== version;

  if (
    installAlreadyPresent &&
    !force &&
    !versionMismatch &&
    !isValidInstalledPluginDir(pluginPath)
  ) {
    throw new Error(
      `Existing install at ${pluginPath} is incomplete or invalid. Re-run with --force to overwrite it.`,
    );
  }

  if (installAlreadyPresent && force) {
    rmSync(pluginPath, { recursive: true, force: true });
  }

  let copied = false;
  if (!installAlreadyPresent || force || versionMismatch) {
    mkdirSync(pluginPath, { recursive: true });
    for (const relativePath of getPackagePayloadPaths(
      packageRoot,
      packageJson,
    )) {
      copyRelativeEntry(packageRoot, pluginPath, relativePath);
    }
    copied = true;
  }

  const agentsChanged = installCodexAgents({ packageRoot, agentsPath });
  const marketplaceChanged = writeMarketplaceManifest({
    marketplacePath,
    marketplaceRoot,
    pluginPath,
  });
  const legacyCleanup = cleanLegacyMarketplaceEntry({ userHome });
  const registration = register({ marketplaceRoot, env });

  return {
    ok: true,
    action: "install",
    plugin: PLUGIN_ID,
    marketplaceName: MARKETPLACE_NAME,
    marketplaceRoot,
    marketplaceRegistered: registration.registered,
    version,
    codexHome,
    agentsPath,
    pluginPath,
    marketplacePath,
    copied,
    overwritten: installAlreadyPresent && force,
    pluginUpdated: installAlreadyPresent && versionMismatch && !force,
    previousVersion,
    agentsChanged,
    marketplaceChanged,
    legacyEntryRemoved: legacyCleanup.entryRemoved,
    legacyMarketplaceRemoved: legacyCleanup.fileRemoved,
    ...(registration.error ? { marketplaceRegistrationError: registration.error } : {}),
  };
}

/**
 * Register the dedicated root with codex. Idempotent: codex reports `alreadyAdded` and
 * exits 0 when the source is already configured, so this is safe on every update run.
 */
export function registerMarketplace({ marketplaceRoot, env = process.env }) {
  const result = spawnSync(
    "codex",
    ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
    { encoding: "utf8", env },
  );

  if (result.error) {
    // codex not on PATH: materialization still succeeded, but the marketplace is not
    // discoverable until someone registers it. Surface it rather than failing the install.
    return {
      registered: false,
      error: `Could not run \`codex\`: ${result.error.message}. Run \`codex plugin marketplace add ${marketplaceRoot}\` once codex is available.`,
    };
  }

  if (result.status !== 0) {
    return {
      registered: false,
      error: `\`codex plugin marketplace add\` failed: ${(result.stderr || "").trim()}`,
    };
  }

  return { registered: true };
}

/**
 * Remove the entry older versions injected into the shared marketplace.
 *
 * Two reasons this is not merely cosmetic:
 *  - If that file is foreign-named, it publishes this plugin as polygraph@<their-name>,
 *    which is the bug being fixed.
 *  - If that file is one we created (name `polygraph-plugins`), it collides by name with
 *    the dedicated root. Codex accepts duplicate names and resolves them silently, so a
 *    stale payload could win. Drop the file when nothing else uses it.
 */
export function cleanLegacyMarketplaceEntry({ userHome }) {
  const legacyPath = getLegacyMarketplacePath(userHome);
  const unchanged = { entryRemoved: false, fileRemoved: false };
  if (!existsSync(legacyPath)) {
    return unchanged;
  }

  let marketplace;
  try {
    marketplace = readJsonFile(legacyPath);
  } catch {
    return unchanged; // not ours to repair
  }

  if (!isPlainObject(marketplace) || !Array.isArray(marketplace.plugins)) {
    return unchanged;
  }

  const remaining = marketplace.plugins.filter(
    (plugin) => plugin?.name !== PLUGIN_NAME,
  );
  if (remaining.length === marketplace.plugins.length) {
    return unchanged;
  }

  // A file we authored: our name, and nothing else left in it. Remove it outright so it
  // cannot shadow the dedicated marketplace of the same name.
  if (remaining.length === 0 && marketplace.name === MARKETPLACE_NAME) {
    rmSync(legacyPath, { force: true });
    rmSync(getLegacyPluginInstallPath(userHome), {
      recursive: true,
      force: true,
    });
    return { entryRemoved: true, fileRemoved: true };
  }

  // Someone else's file: take our entry back out and leave everything else untouched.
  writeJsonFile(legacyPath, { ...marketplace, plugins: remaining });
  rmSync(getLegacyPluginInstallPath(userHome), {
    recursive: true,
    force: true,
  });
  return { entryRemoved: true, fileRemoved: false };
}

export function checkInstall({ packageRoot, env = process.env } = {}) {
  let version = null;
  if (packageRoot) {
    ({ version } = loadPackageMetadata(packageRoot));
  }

  const codexHome = resolveCodexHome(env);
  const userHome = resolveUserHome(env);
  const agentsPath = getAgentsPath(codexHome);
  const marketplaceRoot = getMarketplaceRoot(userHome);
  const marketplacePath = getMarketplacePath(marketplaceRoot);
  const pluginPath = getPluginInstallPath(marketplaceRoot);
  const pluginInstalled = isValidInstalledPluginDir(pluginPath);
  const agentsInstalled = packageRoot
    ? areCodexAgentsInstalled({ packageRoot, agentsPath })
    : hasDefaultCodexAgents(agentsPath);
  const marketplaceConfigured = isPluginConfiguredInMarketplace({
    marketplacePath,
    marketplaceRoot,
    pluginPath,
  });
  const legacyMarketplacePresent = hasLegacyPluginEntry({ userHome });
  const ok =
    pluginInstalled &&
    agentsInstalled &&
    marketplaceConfigured &&
    !legacyMarketplacePresent;

  return {
    ok,
    action: "check",
    plugin: PLUGIN_ID,
    marketplaceName: MARKETPLACE_NAME,
    marketplaceRoot,
    codexHome,
    agentsPath,
    pluginPath,
    marketplacePath,
    pluginInstalled,
    agentsInstalled,
    marketplaceConfigured,
    legacyMarketplacePresent,
  };
}

/** True when an older install still publishes this plugin from the shared file. */
export function hasLegacyPluginEntry({ userHome }) {
  const legacyPath = getLegacyMarketplacePath(userHome);
  if (!existsSync(legacyPath)) {
    return false;
  }

  try {
    const marketplace = readJsonFile(legacyPath);
    return (
      Array.isArray(marketplace?.plugins) &&
      marketplace.plugins.some((plugin) => plugin?.name === PLUGIN_NAME)
    );
  } catch {
    return false;
  }
}

function getPackagePayloadPaths(packageRoot, packageJson) {
  const relativePaths = new Set(packageJson.files ?? []);
  relativePaths.add("package.json");

  if (packageJson.bin) {
    for (const relativePath of Object.values(packageJson.bin)) {
      relativePaths.add(relativePath);
    }
  }

  for (const extraFile of ["README.md", "LICENSE"]) {
    if (existsSync(join(packageRoot, extraFile))) {
      relativePaths.add(extraFile);
    }
  }

  return [...relativePaths];
}

function copyRelativeEntry(sourceRoot, targetRoot, relativePath) {
  const sourcePath = join(sourceRoot, relativePath);
  if (!existsSync(sourcePath)) {
    return;
  }

  cpSync(sourcePath, join(targetRoot, relativePath), { recursive: true });
}

export function installCodexAgents({ packageRoot, agentsPath }) {
  const agentFiles = listPackageAgentFiles(packageRoot);
  if (agentFiles.length === 0) {
    return false;
  }

  mkdirSync(agentsPath, { recursive: true });

  let changed = false;
  for (const agentFile of agentFiles) {
    const sourcePath = join(packageRoot, "agents", agentFile);
    const targetPath = join(agentsPath, agentFile);
    const sourceContent = readFileSync(sourcePath, "utf8");
    const targetContent = existsSync(targetPath)
      ? readFileSync(targetPath, "utf8")
      : null;

    if (targetContent !== sourceContent) {
      writeFileSync(targetPath, sourceContent);
      changed = true;
    }
  }

  return changed;
}

export function areCodexAgentsInstalled({ packageRoot, agentsPath }) {
  const agentFiles = listPackageAgentFiles(packageRoot);
  if (agentFiles.length === 0) {
    return false;
  }

  return agentFiles.every((agentFile) => {
    const sourcePath = join(packageRoot, "agents", agentFile);
    const targetPath = join(agentsPath, agentFile);

    return (
      existsSync(targetPath) &&
      readFileSync(targetPath, "utf8") === readFileSync(sourcePath, "utf8")
    );
  });
}

function listPackageAgentFiles(packageRoot) {
  const agentsDir = join(packageRoot, "agents");
  if (!existsSync(agentsDir)) {
    return [];
  }

  return readdirSync(agentsDir)
    .filter((entry) => entry.endsWith(".toml"))
    .sort();
}

function hasDefaultCodexAgents(agentsPath) {
  return ["polygraph-delegate-subagent.toml", "polygraph-init-subagent.toml"].every(
    (agentFile) => existsSync(join(agentsPath, agentFile)),
  );
}

/**
 * Write the manifest for the marketplace Polygraph owns.
 *
 * The name is set unconditionally. The previous implementation preserved an existing
 * `name` here, which is what let a foreign marketplace rename this plugin. Nothing else
 * publishes into this root, so there is no third-party state to preserve.
 */
export function writeMarketplaceManifest({
  marketplacePath,
  marketplaceRoot,
  pluginPath,
}) {
  const nextMarketplace = {
    name: MARKETPLACE_NAME,
    interface: { displayName: MARKETPLACE_DISPLAY_NAME },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: {
          source: "local",
          path: toMarketplaceSourcePath(marketplaceRoot, pluginPath),
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ],
  };

  const marketplace = readJsonFile(marketplacePath, null);
  const changed =
    JSON.stringify(nextMarketplace) !== JSON.stringify(marketplace);
  if (changed) {
    writeJsonFile(marketplacePath, nextMarketplace);
  }

  return changed;
}

export function isPluginConfiguredInMarketplace({
  marketplacePath,
  marketplaceRoot,
  pluginPath,
}) {
  if (!existsSync(marketplacePath)) {
    return false;
  }

  let marketplace;
  try {
    marketplace = readJsonFile(marketplacePath);
  } catch {
    return false;
  }

  // The name is what codex builds the plugin id from, so a manifest that resolves the
  // payload correctly but carries the wrong name is still broken. Validating only the
  // source path is what previously let `check` pass on a broken install.
  if (marketplace?.name !== MARKETPLACE_NAME) {
    return false;
  }

  if (!Array.isArray(marketplace.plugins)) {
    return false;
  }

  const pluginEntry = marketplace.plugins.find(
    (plugin) => plugin?.name === PLUGIN_NAME,
  );
  if (
    !isPlainObject(pluginEntry?.source) ||
    pluginEntry.source.source !== "local"
  ) {
    return false;
  }

  const configuredPath = resolve(marketplaceRoot, pluginEntry.source.path);
  return configuredPath === resolve(pluginPath);
}

function readJsonFile(path, fallbackValue) {
  if (!existsSync(path)) {
    return fallbackValue;
  }

  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isValidInstalledPluginDir(candidatePath) {
  const pluginManifestPath = join(
    candidatePath,
    ".codex-plugin",
    "plugin.json",
  );
  const mcpConfigPath = join(candidatePath, ".mcp.json");
  const skillsPath = join(candidatePath, "skills");

  if (
    !existsSync(pluginManifestPath) ||
    !existsSync(mcpConfigPath) ||
    !existsSync(skillsPath)
  ) {
    return false;
  }

  try {
    const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, "utf8"));
    return pluginManifest.name === PLUGIN_NAME;
  } catch {
    return false;
  }
}

function expandHome(inputPath, env) {
  if (!inputPath.startsWith("~")) {
    return inputPath;
  }

  const userHome = env.HOME?.trim() || homedir();
  if (inputPath === "~") {
    return userHome;
  }

  if (inputPath.startsWith("~/")) {
    return join(userHome, inputPath.slice(2));
  }

  return inputPath;
}

function toMarketplaceSourcePath(marketplaceRoot, targetPath) {
  const relativePath = relative(marketplaceRoot, targetPath);
  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".."
  ) {
    throw new Error(
      `Expected plugin install path ${targetPath} to be inside ${marketplaceRoot} so it can be referenced from the marketplace manifest`,
    );
  }

  return `./${relativePath.split(sep).join("/")}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
