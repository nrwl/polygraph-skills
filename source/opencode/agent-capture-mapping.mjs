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
// File contract:
//   ~/.polygraph/sidecars/<POLYGRAPH_SESSION_ID>/mapping-opencode-<sessionId>.json
//
// Behaviour:
//   - Silent no-op when POLYGRAPH_SESSION_ID is unset or POLYGRAPH_CHILD_AGENT is set.
//   - Atomic write via tmp-file rename.
//   - Refresh: preserves firstSeenAt when a valid prior mapping exists.
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

/**
 * Write (or refresh) the agent-capture mapping for an OpenCode session.
 * Reads POLYGRAPH_SESSION_ID and POLYGRAPH_CHILD_AGENT from process.env.
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

    const sidecarDir = path.join(home, '.polygraph', 'sidecars', polygraphSessionId);
    mkdirSync(sidecarDir, { recursive: true });

    const filenamePart = sanitizeMappingFilename(`opencode-${agentSessionId}`);
    const finalPath = path.join(sidecarDir, `mapping-${filenamePart}.json`);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;

    const now = Date.now();
    let firstSeenAt = now;

    if (existsSync(finalPath)) {
      try {
        const existing = JSON.parse(readFileSync(finalPath, 'utf8'));
        if (
          existing.version === 1 &&
          existing.polygraphSessionId === polygraphSessionId &&
          existing.agentSessionId === agentSessionId &&
          Number.isFinite(existing.firstSeenAt)
        ) {
          firstSeenAt = existing.firstSeenAt;
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
