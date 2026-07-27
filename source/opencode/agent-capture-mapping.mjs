// Agent-capture mapping writer for the OpenCode plugin.
// Exported from this sibling module (NOT from server.js) so it can be tested
// independently. See server.js for the constraint on why server.js itself must
// stay export-free beyond its plugin entry.
//
// Records the (agentSessionId ↔ polygraphSessionId) mapping file so the
// Polygraph CLI can bind parent-log capture deterministically. Written on
// every session start and compaction; the CLI reader looks for mapping-*.json
// files in the per-session sidecars directory.
//
// File contract (must match the Polygraph CLI reader exactly):
//   <sessionsRoot>/<POLYGRAPH_SESSION_ID>/sidecars/mapping-opencode-<sessionId>.json
//     where sessionsRoot = $POLYGRAPH_ROOT, else `globalRoot` from
//     ~/.polygraph/config.json, else ~/.polygraph/sessions
//   Legacy fallback, used ONLY when <sessionsRoot>/<POLYGRAPH_SESSION_ID>
//   does not exist (for real sessions nothing new is written here):
//   ~/.polygraph/sidecars/<POLYGRAPH_SESSION_ID>/mapping-opencode-<sessionId>.json
//
// The session folder is a trustworthy location for this parent-transcript
// binding because the Polygraph CLI's child-agent sandboxes exclude the
// session root — children cannot write there. The CLI reads mappings from
// the session folder first, with the flat dir as a read-only fallback.
//
// Behaviour:
//   - Silent no-op when POLYGRAPH_SESSION_ID is unset or POLYGRAPH_CHILD_AGENT is set.
//   - Atomic write via tmp-file rename.
//   - Refresh: preserves firstSeenAt when a valid prior mapping exists
//     (checked in the new location first, then the legacy flat dir — keeps
//     firstSeenAt continuity when migrating a mapping from the legacy dir).
//   - All failures are silently swallowed.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function sanitizeMappingFilename(str) {
  return str.replace(/[^A-Za-z0-9._-]/g, '_');
}

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
 *
 * Hooks otherwise swallow their errors silently (a broken hook must never break
 * the agent session) and must never write to stdout — so this on-disk log is the
 * only record that something went wrong. The logger is itself failure-proof:
 * any error here is swallowed so a logging bug can never break a hook.
 *
 * @param {string} hook        Identifier for the failing hook.
 * @param {unknown} error      The thrown value.
 * @param {object} [meta]      Extra context to record (sessionID, etc.).
 * @param {string} [home]      Override HOME for testing.
 */
export function logHookFailure(
  hook,
  error,
  meta = {},
  home = process.env.HOME?.trim() || homedir()
) {
  try {
    const logsDir = path.join(home, '.polygraph', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'hooks.log');

    // Best-effort rotation so the log can't grow unbounded.
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

// Resolve the root directory that holds per-session folders:
// $POLYGRAPH_ROOT, else `globalRoot` from ~/.polygraph/config.json, else
// ~/.polygraph/sessions. Must match the Polygraph CLI's own resolution.
function sessionsRoot(home) {
  const fromEnv = process.env.POLYGRAPH_ROOT?.trim();
  if (fromEnv) return fromEnv;

  try {
    const config = JSON.parse(
      readFileSync(path.join(home, '.polygraph', 'config.json'), 'utf8')
    );
    if (typeof config?.globalRoot === 'string' && config.globalRoot.trim()) {
      return config.globalRoot.trim();
    }
  } catch {
    // no config — use the default
  }

  return path.join(home, '.polygraph', 'sessions');
}

/**
 * Write (or refresh) the agent-capture mapping for an OpenCode session.
 *
 * Written into the session folder (`<sessionsRoot>/<sessionId>/sidecars/`)
 * when the session directory exists; only when it does not exist does the
 * write fall back to the legacy flat `~/.polygraph/sidecars/<sessionId>/`
 * dir. Reads POLYGRAPH_SESSION_ID and POLYGRAPH_CHILD_AGENT from process.env.
 *
 * @param {string} agentSessionId  The OpenCode session id (input.sessionID).
 * @param {string} [home]          Override HOME for testing.
 */
export function writeAgentCaptureMapping(
  agentSessionId,
  home = process.env.HOME?.trim() || homedir()
) {
  try {
    const polygraphSessionId = process.env.POLYGRAPH_SESSION_ID;
    if (!polygraphSessionId) return;
    if (process.env.POLYGRAPH_CHILD_AGENT) return;
    if (!agentSessionId) return;

    const filenamePart = sanitizeMappingFilename(`opencode-${agentSessionId}`);
    const fileName = `mapping-${filenamePart}.json`;

    const sessionDir = path.join(sessionsRoot(home), polygraphSessionId);
    const sessionSidecarDir = path.join(sessionDir, 'sidecars');
    const legacyDir = path.join(home, '.polygraph', 'sidecars', polygraphSessionId);

    // New location when the session directory exists; legacy flat dir only
    // when it does not.
    const targetDir = existsSync(sessionDir) ? sessionSidecarDir : legacyDir;
    mkdirSync(targetDir, { recursive: true });

    const finalPath = path.join(targetDir, fileName);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;

    const now = Date.now();

    // Refresh semantics: preserve firstSeenAt from a valid prior mapping.
    // Check the new location first, then the legacy flat dir — this keeps
    // firstSeenAt continuity when migrating a mapping from the legacy dir.
    let firstSeenAt = now;
    for (const candidate of [
      path.join(sessionSidecarDir, fileName),
      path.join(legacyDir, fileName),
    ]) {
      if (!existsSync(candidate)) continue;
      try {
        const existing = JSON.parse(readFileSync(candidate, 'utf8'));
        if (
          existing.version === 1 &&
          existing.polygraphSessionId === polygraphSessionId &&
          existing.agentSessionId === agentSessionId &&
          Number.isFinite(existing.firstSeenAt)
        ) {
          firstSeenAt = existing.firstSeenAt;
          break;
        }
      } catch {
        // ignore — treat as missing
      }
    }

    const mapping = {
      version: 1,
      polygraphSessionId,
      agentType: 'opencode',
      agentSessionId,
      cwd: process.cwd(),
      // OpenCode transcripts are resolved by the CLI from its own storage by
      // session id, so we omit transcriptPath here.
      pid: process.pid,
      source: 'hook',
      firstSeenAt,
      lastSeenAt: now,
    };

    writeFileSync(tmpPath, JSON.stringify(mapping, null, 2) + '\n');
    renameSync(tmpPath, finalPath);
  } catch (error) {
    // Silent toward the agent — a broken plugin hook must never break the
    // session — but record it so failures are not invisible.
    logHookFailure('opencode:writeAgentCaptureMapping', error, { agentSessionId }, home);
  }
}
