// SessionStart hook — checks whether the installed Polygraph plugin is
// outdated and, when it is, emits a single stdout message so the agent
// surfaces the problem to the user. Stale plugin versions have silently
// caused incorrect Polygraph behavior in the past; this makes it visible
// for agent launches that bypass the polygraph CLI (e.g. desktop apps).
//
// Unlike the sibling hooks, this one deliberately writes to stdout — but
// ONLY when the plugin is outdated. When current, unknown, offline, or on
// any error it prints nothing and exits 0.
//
// The harness ('claude' | 'codex') is passed as the first CLI argument so
// the same script ships in both plugin artifacts.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

const PACKAGE_BY_HARNESS = {
  claude: '@polygraph/claude-plugin',
  codex: '@polygraph/codex-plugin',
};

const REMEDIATION_BY_HARNESS = {
  claude: 'run `claude plugins update polygraph@polygraph-plugins`',
  codex:
    'run `npx --prefer-online @polygraph/codex-plugin@latest install` then `codex plugin add polygraph@polygraph-plugins`',
};

// Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
// This hook swallows its errors silently, so this on-disk log is the only
// record that something went wrong. The logger is itself failure-proof.
function logHookFailure(
  hook,
  error,
  meta = {},
  home = process.env.HOME?.trim() || homedir()
) {
  try {
    const logsDir = join(home, '.polygraph', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'hooks.log');

    try {
      if (statSync(logFile).size > HOOK_LOG_MAX_BYTES) {
        renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // no prior log, or rotation failed — ignore
    }

    const entry = {
      time: new Date().toISOString(),
      hook,
      pid: process.pid,
      ...meta,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never throw — a failing logger must not break the hook.
  }
}

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const match = version
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

// Returns -1, 0, or 1 when a is lower than, equal to, or higher than b.
// Returns null when either version is unparseable.
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }

  // Same core version: a prerelease sorts below a release.
  if (pa.prerelease.length && !pb.prerelease.length) return -1;
  if (!pa.prerelease.length && pb.prerelease.length) return 1;

  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ia = pa.prerelease[i];
    const ib = pb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    if (ia === ib) continue;
    const na = /^\d+$/.test(ia) ? Number(ia) : null;
    const nb = /^\d+$/.test(ib) ? Number(ib) : null;
    if (na !== null && nb !== null) return na < nb ? -1 : 1;
    if (na !== null) return -1; // numeric identifiers sort below alphanumeric
    if (nb !== null) return 1;
    return ia < ib ? -1 : 1;
  }
  return 0;
}

// Resolve the installed plugin version from the manifest shipped alongside
// this script: <pluginRoot>/hooks/check-plugin-version.mjs sits next to
// .claude-plugin/plugin.json (Claude), .codex-plugin/plugin.json (Codex),
// or package.json.
export function resolveInstalledVersion(pluginRoot) {
  const manifests = [
    join(pluginRoot, '.claude-plugin', 'plugin.json'),
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    join(pluginRoot, 'package.json'),
  ];
  for (const manifestPath of manifests) {
    let raw;
    try {
      raw = readFileSync(manifestPath, 'utf8');
    } catch {
      continue;
    }
    const parsed = tryParseJson(raw);
    if (parsed && parseSemver(parsed.version)) return parsed.version.trim();
  }
  return null;
}

function cachePath(harness, home) {
  return join(home, '.polygraph', 'logs', `plugin-version-check-${harness}.json`);
}

export function readCache(harness, home) {
  try {
    return tryParseJson(readFileSync(cachePath(harness, home), 'utf8'));
  } catch {
    return null;
  }
}

// A cache entry is only trusted when it is recent, was recorded for the
// currently installed version (updating the plugin invalidates it), and holds
// either a parseable latest version or null (a negatively-cached failed
// fetch, so an offline machine does not re-stall on every session start).
export function isCacheFresh(cache, installed, now) {
  return Boolean(
    cache &&
      Number.isFinite(cache.checkedAt) &&
      now - cache.checkedAt >= 0 &&
      now - cache.checkedAt < CACHE_MAX_AGE_MS &&
      cache.installed === installed &&
      (cache.latest === null || parseSemver(cache.latest))
  );
}

function writeCache(harness, home, entry) {
  const path = cachePath(harness, home);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(entry) + '\n');
  renameSync(tmpPath, path);
}

async function fetchLatestVersion(packageName, fetchImpl) {
  const registry = (process.env.npm_config_registry?.trim() || DEFAULT_REGISTRY)
    .replace(/\/+$/, '');
  const url = `${registry}/-/package/${packageName.replace('/', '%2f')}/dist-tags`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status}`);
  const distTags = await response.json();
  return typeof distTags?.latest === 'string' ? distTags.latest : null;
}

export function buildOutdatedMessage(harness, installed, latest) {
  return (
    `The Polygraph plugin is outdated: ${installed} installed, ${latest} latest. ` +
    'Stale plugin versions cause incorrect Polygraph behavior. ' +
    `Tell the user to update it now: ${REMEDIATION_BY_HARNESS[harness]} ` +
    '(or re-run `polygraph config`), then restart the agent session.'
  );
}

/**
 * Check whether the installed plugin is outdated.
 *
 * @param {object} opts
 * @param {string} opts.harness     'claude' | 'codex'
 * @param {string} opts.pluginRoot  Directory containing the plugin manifest.
 * @param {string} [opts.home]      Override HOME for testing.
 * @param {Function} [opts.fetchImpl] Override fetch for testing.
 * @param {number} [opts.now]       Override the clock for testing.
 * @returns {Promise<string|null>} The message to emit, or null to stay silent.
 */
export async function checkPluginVersion({
  harness,
  pluginRoot,
  home = process.env.HOME?.trim() || homedir(),
  fetchImpl = fetch,
  now = Date.now(),
}) {
  const packageName = PACKAGE_BY_HARNESS[harness];
  if (!packageName) return null;

  const installed = resolveInstalledVersion(pluginRoot);
  if (!installed) return null;

  let latest;
  const cache = readCache(harness, home);
  if (isCacheFresh(cache, installed, now)) {
    if (cache.latest === null) return null;
    latest = cache.latest;
  } else {
    try {
      latest = await fetchLatestVersion(packageName, fetchImpl);
    } catch (error) {
      // Negative cache: remember the failed fetch so an offline machine
      // does not re-stall for the fetch timeout on every session start.
      writeCache(harness, home, { checkedAt: now, installed, latest: null });
      throw error;
    }
    if (!parseSemver(latest)) {
      writeCache(harness, home, { checkedAt: now, installed, latest: null });
      return null;
    }
    writeCache(harness, home, { checkedAt: now, installed, latest });
  }

  if (compareSemver(installed, latest) === -1) {
    return buildOutdatedMessage(harness, installed, latest);
  }
  return null;
}

export async function main() {
  const harness = process.argv[2];
  try {
    const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const message = await checkPluginVersion({ harness, pluginRoot });
    if (message) process.stdout.write(message + '\n');
  } catch (error) {
    // Offline or broken registry must never block or pollute the session,
    // but record it so failures are not invisible.
    logHookFailure(`${harness || 'unknown'}:check-plugin-version`, error);
  }
  process.exitCode = 0;
}

// Run only when executed directly as a hook, not when imported (e.g. by tests).
// realpathSync both sides so the check holds when the plugin lives under a
// symlinked path (e.g. macOS /tmp -> /private/tmp).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
