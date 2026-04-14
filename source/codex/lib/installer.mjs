import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'smol-toml';

const PLUGIN_NAME = 'polygraph';
const PLUGIN_ID = 'polygraph@polygraph';

export function getPackageRootFromMetaUrl(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), '..');
}

export function resolveCodexHome(env = process.env) {
  const configuredHome = env.CODEX_HOME?.trim();
  if (configuredHome) {
    return resolve(expandHome(configuredHome, env));
  }

  const userHome = env.HOME?.trim() || homedir();
  return join(resolve(expandHome(userHome, env)), '.codex');
}

export function getConfigPath(codexHome) {
  return join(codexHome, 'config.toml');
}

export function getCacheRoot(codexHome) {
  return join(codexHome, 'plugins', 'cache', PLUGIN_NAME, PLUGIN_NAME);
}

export function loadPackageMetadata(packageRoot) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const pluginManifestPath = join(packageRoot, '.codex-plugin', 'plugin.json');

  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing package.json at ${packageJsonPath}`);
  }

  if (!existsSync(pluginManifestPath)) {
    throw new Error(`Missing Codex plugin manifest at ${pluginManifestPath}`);
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));

  if (pluginManifest.name !== PLUGIN_NAME) {
    throw new Error(
      `Expected .codex-plugin/plugin.json name to be "${PLUGIN_NAME}", received "${pluginManifest.name ?? 'undefined'}"`
    );
  }

  if (!packageJson.version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }

  if (pluginManifest.version && pluginManifest.version !== packageJson.version) {
    throw new Error(
      `Package version mismatch: package.json has "${packageJson.version}" but plugin manifest has "${pluginManifest.version}"`
    );
  }

  return {
    packageJson,
    pluginManifest,
    version: packageJson.version,
  };
}

export function installPlugin({
  packageRoot,
  env = process.env,
  force = false,
} = {}) {
  if (!packageRoot) {
    throw new Error('packageRoot is required');
  }

  const { packageJson, version } = loadPackageMetadata(packageRoot);
  const codexHome = resolveCodexHome(env);
  const configPath = getConfigPath(codexHome);
  const cacheRoot = getCacheRoot(codexHome);
  const installPath = join(cacheRoot, version);
  const installAlreadyPresent = existsSync(installPath);

  if (installAlreadyPresent && !force && !isValidInstalledVersionDir(installPath)) {
    throw new Error(
      `Existing install at ${installPath} is incomplete or invalid. Re-run with --force to overwrite it.`
    );
  }

  if (installAlreadyPresent && force) {
    rmSync(installPath, { recursive: true, force: true });
  }

  let copied = false;
  if (!installAlreadyPresent || force) {
    mkdirSync(installPath, { recursive: true });
    for (const relativePath of getPackagePayloadPaths(packageRoot, packageJson)) {
      copyRelativeEntry(packageRoot, installPath, relativePath);
    }
    copied = true;
  }

  const configChanged = enablePluginInConfig(configPath);

  return {
    ok: true,
    action: 'install',
    plugin: PLUGIN_ID,
    version,
    codexHome,
    installPath,
    configPath,
    copied,
    overwritten: installAlreadyPresent && force,
    configChanged,
  };
}

export function checkInstall({
  packageRoot,
  env = process.env,
} = {}) {
  if (packageRoot) {
    loadPackageMetadata(packageRoot);
  }

  const codexHome = resolveCodexHome(env);
  const configPath = getConfigPath(codexHome);
  const cacheRoot = getCacheRoot(codexHome);
  const installedVersions = findInstalledVersions(cacheRoot);
  const configEnabled = isPluginEnabled(configPath);
  const ok = installedVersions.length > 0 && configEnabled;

  return {
    ok,
    action: 'check',
    plugin: PLUGIN_ID,
    codexHome,
    cacheRoot,
    configPath,
    configEnabled,
    installedVersions,
  };
}

export function enablePluginInConfig(configPath) {
  const config = readTomlFile(configPath);

  if (config.plugins !== undefined && !isPlainObject(config.plugins)) {
    throw new Error(`Expected plugins table in ${configPath} to be a TOML table`);
  }

  const plugins = config.plugins ?? {};
  const pluginConfig = plugins[PLUGIN_ID];

  if (pluginConfig !== undefined && !isPlainObject(pluginConfig)) {
    throw new Error(`Expected plugins."${PLUGIN_ID}" in ${configPath} to be a TOML table`);
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

export function findInstalledVersions(cacheRoot) {
  if (!existsSync(cacheRoot)) {
    return [];
  }

  return readdirSync(cacheRoot)
    .filter((entry) => {
      const candidatePath = join(cacheRoot, entry);
      return statSync(candidatePath).isDirectory() && isValidInstalledVersionDir(candidatePath, entry);
    })
    .sort();
}

function getPackagePayloadPaths(packageRoot, packageJson) {
  const relativePaths = new Set(packageJson.files ?? []);
  relativePaths.add('package.json');

  if (packageJson.bin) {
    for (const relativePath of Object.values(packageJson.bin)) {
      relativePaths.add(relativePath);
    }
  }

  for (const extraFile of ['README.md', 'LICENSE']) {
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

function readTomlFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') {
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

function isValidInstalledVersionDir(candidatePath, expectedVersion) {
  const pluginManifestPath = join(candidatePath, '.codex-plugin', 'plugin.json');
  const mcpConfigPath = join(candidatePath, '.mcp.json');
  const skillsPath = join(candidatePath, 'skills');

  if (!existsSync(pluginManifestPath) || !existsSync(mcpConfigPath) || !existsSync(skillsPath)) {
    return false;
  }

  try {
    const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
    if (pluginManifest.name !== PLUGIN_NAME) {
      return false;
    }

    if (expectedVersion && pluginManifest.version && pluginManifest.version !== expectedVersion) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function expandHome(inputPath, env) {
  if (!inputPath.startsWith('~')) {
    return inputPath;
  }

  const userHome = env.HOME?.trim() || homedir();
  if (inputPath === '~') {
    return userHome;
  }

  if (inputPath.startsWith('~/')) {
    return join(userHome, inputPath.slice(2));
  }

  return inputPath;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
