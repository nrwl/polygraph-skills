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
import { parse, stringify } from "smol-toml";

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

export function getConfigPath(codexHome) {
  return join(codexHome, "config.toml");
}

export function getAgentsPath(codexHome) {
  return join(codexHome, "agents");
}

export function getCacheRoot(codexHome, version) {
  const base = join(
    codexHome,
    "plugins",
    "cache",
    MARKETPLACE_NAME,
    PLUGIN_NAME,
  );
  return version ? join(base, version) : base;
}

export function resolveUserHome(env = process.env) {
  const userHome = env.HOME?.trim() || homedir();
  return resolve(expandHome(userHome, env));
}

export function getMarketplacePath(userHome) {
  return join(userHome, ".agents", "plugins", "marketplace.json");
}

export function getPluginInstallPath(userHome) {
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
 * Mirror the plugin payload into Codex's own plugin cache directory.
 *
 * Workaround for openai/codex#21138: Codex only refreshes its plugin cache
 * when the Plugins UI RPC handler runs, which never happens during normal
 * TUI/MCP/exec sessions. Without this mirror, users keep loading a stale
 * cached copy after a polygraph install — including across version bumps.
 * Remove this workaround once Codex refreshes the cache on plugin load/exec.
 *
 * Returns the versioned cache path that was written, or null if skipped
 * (codexHome does not exist — user hasn't run Codex yet).
 */
function mirrorCodexPluginCache({ codexHome, packageRoot, packageJson, version }) {
  if (!existsSync(codexHome)) {
    return null;
  }

  const pluginCacheRoot = getCacheRoot(codexHome);

  // Remove all existing version directories to prevent accumulation of stale versions.
  if (existsSync(pluginCacheRoot)) {
    for (const entry of readdirSync(pluginCacheRoot)) {
      rmSync(join(pluginCacheRoot, entry), { recursive: true, force: true });
    }
  }

  const versionedCachePath = getCacheRoot(codexHome, version);
  mkdirSync(versionedCachePath, { recursive: true });

  for (const relativePath of getPackagePayloadPaths(packageRoot, packageJson)) {
    copyRelativeEntry(packageRoot, versionedCachePath, relativePath);
  }

  return versionedCachePath;
}

export function installPlugin({
  packageRoot,
  env = process.env,
  force = false,
} = {}) {
  if (!packageRoot) {
    throw new Error("packageRoot is required");
  }

  const { packageJson, version } = loadPackageMetadata(packageRoot);
  const codexHome = resolveCodexHome(env);
  const userHome = resolveUserHome(env);
  const configPath = getConfigPath(codexHome);
  const agentsPath = getAgentsPath(codexHome);
  const marketplacePath = getMarketplacePath(userHome);
  const pluginPath = getPluginInstallPath(userHome);
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

  const configChanged = enablePluginInConfig(configPath);
  const agentsChanged = installCodexAgents({ packageRoot, agentsPath });
  const marketplaceChanged = enablePluginInMarketplace({
    marketplacePath,
    pluginPath,
    userHome,
  });

  // Always mirror into Codex's plugin cache, regardless of whether the main
  // install was a no-op. The cache can be stale independently of pluginPath.
  const codexCachePath = mirrorCodexPluginCache({
    codexHome,
    packageRoot,
    packageJson,
    version,
  });

  return {
    ok: true,
    action: "install",
    plugin: PLUGIN_ID,
    version,
    codexHome,
    agentsPath,
    pluginPath,
    configPath,
    marketplacePath,
    codexCachePath,
    copied,
    overwritten: installAlreadyPresent && force,
    pluginUpdated: installAlreadyPresent && versionMismatch && !force,
    previousVersion,
    configChanged,
    agentsChanged,
    marketplaceChanged,
  };
}

export function checkInstall({ packageRoot, env = process.env } = {}) {
  let version = null;
  if (packageRoot) {
    ({ version } = loadPackageMetadata(packageRoot));
  }

  const codexHome = resolveCodexHome(env);
  const userHome = resolveUserHome(env);
  const configPath = getConfigPath(codexHome);
  const agentsPath = getAgentsPath(codexHome);
  const marketplacePath = getMarketplacePath(userHome);
  const pluginPath = getPluginInstallPath(userHome);
  const pluginInstalled = isValidInstalledPluginDir(pluginPath);
  const configEnabled = isPluginEnabled(configPath);
  const agentsInstalled = packageRoot
    ? areCodexAgentsInstalled({ packageRoot, agentsPath })
    : hasDefaultCodexAgents(agentsPath);
  const marketplaceConfigured = isPluginConfiguredInMarketplace({
    marketplacePath,
    userHome,
    pluginPath,
  });
  const ok =
    pluginInstalled && configEnabled && agentsInstalled && marketplaceConfigured;

  // Check whether Codex's plugin cache contains a current mirror of the install.
  // codexCachePath is the expected path; codexCacheMirrored is whether its
  // content matches pluginPath (null when codexHome doesn't exist or version unknown).
  const codexHomeExists = existsSync(codexHome);
  const codexCachePath =
    codexHomeExists && version ? getCacheRoot(codexHome, version) : null;
  const codexCacheMirrored =
    codexCachePath !== null
      ? isCodexCacheCurrent({ cachePath: codexCachePath, pluginPath })
      : null;

  return {
    ok,
    action: "check",
    plugin: PLUGIN_ID,
    codexHome,
    agentsPath,
    pluginPath,
    configPath,
    marketplacePath,
    codexCachePath,
    pluginInstalled,
    configEnabled,
    agentsInstalled,
    marketplaceConfigured,
    codexCacheMirrored,
  };
}

export function enablePluginInConfig(configPath) {
  const config = readTomlFile(configPath);

  if (config.plugins !== undefined && !isPlainObject(config.plugins)) {
    throw new Error(
      `Expected plugins table in ${configPath} to be a TOML table`,
    );
  }

  const plugins = config.plugins ?? {};
  const pluginConfig = plugins[PLUGIN_ID];

  if (pluginConfig !== undefined && !isPlainObject(pluginConfig)) {
    throw new Error(
      `Expected plugins."${PLUGIN_ID}" in ${configPath} to be a TOML table`,
    );
  }

  const wasEnabled = pluginConfig?.enabled === true;
  plugins[PLUGIN_ID] = { ...(pluginConfig ?? {}), enabled: true };
  config.plugins = plugins;

  writeTomlFile(configPath, config);

  return !wasEnabled;
}

export function isPluginEnabled(configPath) {
  if (!existsSync(configPath)) {
    return false;
  }

  const config = readTomlFile(configPath);
  return config.plugins?.[PLUGIN_ID]?.enabled === true;
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

export function enablePluginInMarketplace({
  marketplacePath,
  pluginPath,
  userHome,
}) {
  const marketplace = readJsonFile(marketplacePath, {});

  if (
    marketplace.plugins !== undefined &&
    !Array.isArray(marketplace.plugins)
  ) {
    throw new Error(`Expected plugins array in ${marketplacePath}`);
  }

  const marketplacePluginPath = toMarketplaceSourcePath(userHome, pluginPath);
  const nextPluginEntry = {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: marketplacePluginPath,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };

  const plugins = marketplace.plugins ?? [];
  const existingIndex = plugins.findIndex(
    (plugin) => plugin?.name === PLUGIN_NAME,
  );
  const nextPlugins =
    existingIndex === -1
      ? [...plugins, nextPluginEntry]
      : plugins.map((plugin, index) =>
          index === existingIndex ? nextPluginEntry : plugin,
        );

  const nextMarketplace = {
    ...marketplace,
    name: marketplace.name ?? MARKETPLACE_NAME,
    interface: isPlainObject(marketplace.interface)
      ? {
          ...marketplace.interface,
          displayName:
            marketplace.interface.displayName ?? MARKETPLACE_DISPLAY_NAME,
        }
      : { displayName: MARKETPLACE_DISPLAY_NAME },
    plugins: nextPlugins,
  };

  const changed =
    JSON.stringify(nextMarketplace) !== JSON.stringify(marketplace);
  if (changed) {
    writeJsonFile(marketplacePath, nextMarketplace);
  }

  return changed;
}

export function isPluginConfiguredInMarketplace({
  marketplacePath,
  userHome,
  pluginPath,
}) {
  if (!existsSync(marketplacePath)) {
    return false;
  }

  const marketplace = readJsonFile(marketplacePath);
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

  const configuredPath = resolve(userHome, pluginEntry.source.path);
  return configuredPath === resolve(pluginPath);
}

function readTomlFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") {
    return {};
  }

  const parsed = parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error(`Expected TOML document at ${path} to parse to an object`);
  }
  return parsed;
}

function writeTomlFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stringify(value).trimEnd()}\n`);
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

/**
 * Returns true when cachePath exists and every file it contains has the same
 * content as the corresponding file in pluginPath. Directories are traversed
 * recursively. Returns false if any file is missing or differs.
 */
function isCodexCacheCurrent({ cachePath, pluginPath }) {
  if (!existsSync(cachePath) || !existsSync(pluginPath)) {
    return false;
  }

  return directoriesMatch(pluginPath, cachePath);
}

function directoriesMatch(aDir, bDir) {
  if (!existsSync(aDir) || !existsSync(bDir)) {
    return false;
  }

  const aEntries = readdirSync(aDir, { withFileTypes: true }).sort((x, y) =>
    x.name < y.name ? -1 : x.name > y.name ? 1 : 0,
  );
  const bEntries = readdirSync(bDir, { withFileTypes: true }).sort((x, y) =>
    x.name < y.name ? -1 : x.name > y.name ? 1 : 0,
  );

  if (aEntries.length !== bEntries.length) {
    return false;
  }

  for (let i = 0; i < aEntries.length; i++) {
    const a = aEntries[i];
    const b = bEntries[i];

    if (a.name !== b.name || a.isDirectory() !== b.isDirectory()) {
      return false;
    }

    if (a.isDirectory()) {
      if (!directoriesMatch(join(aDir, a.name), join(bDir, b.name))) {
        return false;
      }
    } else {
      const aContent = readFileSync(join(aDir, a.name));
      const bContent = readFileSync(join(bDir, b.name));
      if (!aContent.equals(bContent)) {
        return false;
      }
    }
  }

  return true;
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

function toMarketplaceSourcePath(userHome, targetPath) {
  const relativePath = relative(userHome, targetPath);
  if (
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".."
  ) {
    throw new Error(
      `Expected plugin install path ${targetPath} to be inside ${userHome} so it can be referenced from the personal marketplace`,
    );
  }

  return `./${relativePath.split(sep).join("/")}`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
