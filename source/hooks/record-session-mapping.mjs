// Hidden SessionStart hook — records an agent-capture mapping file that binds
// this agent's session id to the Polygraph session id in the environment.
// Used by both the Claude Code plugin (agentType=claude) and the Codex plugin
// (agentType=codex). The agentType is passed as the first CLI argument so the
// same script ships in both plugin artifacts.
//
// File contract (must match the Polygraph CLI reader exactly):
//   <sessionsRoot>/<POLYGRAPH_SESSION_ID>/sidecars/mapping-<agentType>-<agentSessionId>.json
//     where sessionsRoot = $POLYGRAPH_ROOT, else `globalRoot` from
//     ~/.polygraph/config.json, else ~/.polygraph/sessions
//   Legacy fallback, used ONLY when <sessionsRoot>/<POLYGRAPH_SESSION_ID>
//   does not exist (for real sessions nothing new is written here):
//   ~/.polygraph/sidecars/<POLYGRAPH_SESSION_ID>/mapping-<agentType>-<agentSessionId>.json
//
// The session folder is a trustworthy location for this parent-transcript
// binding because the Polygraph CLI's child-agent sandboxes exclude the
// session root — children cannot write there. The CLI reads mappings from
// the session folder first, with the flat dir as a read-only fallback.
//
// Behaviour:
//   - Silent no-op when POLYGRAPH_SESSION_ID is unset.
//   - Silent no-op when POLYGRAPH_CHILD_AGENT is set (child agents must not
//     register themselves as parents).
//   - Atomic write: write to <path>.tmp-<pid>, then rename over final path.
//   - Refresh: when a valid prior mapping for the same session already exists
//     (checked in the new location first, then the legacy flat dir), preserve
//     its firstSeenAt and only update lastSeenAt + mutable fields — so
//     migrating a mapping from the legacy dir keeps firstSeenAt continuity.
//   - All failures are silently swallowed; never writes to stdout (Claude Code
//     injects hook stdout into the model context); never exits non-zero.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
// This hook swallows its errors silently and must never write to stdout (Claude
// Code injects hook stdout into the model context), so this on-disk log is the
// only record that something went wrong. The logger is itself failure-proof.
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

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function sanitizeFilename(str) {
  return str.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Resolve the root directory that holds per-session folders:
// $POLYGRAPH_ROOT, else `globalRoot` from ~/.polygraph/config.json, else
// ~/.polygraph/sessions. Must match the Polygraph CLI's own resolution.
export function sessionsRoot(home = process.env.HOME?.trim() || homedir()) {
  const fromEnv = process.env.POLYGRAPH_ROOT?.trim();
  if (fromEnv) return fromEnv;

  try {
    const config = tryParseJson(
      readFileSync(join(home, '.polygraph', 'config.json'), 'utf8')
    );
    if (typeof config?.globalRoot === 'string' && config.globalRoot.trim()) {
      return config.globalRoot.trim();
    }
  } catch {
    // no config — use the default
  }

  return join(home, '.polygraph', 'sessions');
}

/**
 * Write (or refresh) the agent-capture mapping file.
 *
 * Written into the session folder (`<sessionsRoot>/<sessionId>/sidecars/`)
 * when the session directory exists; only when it does not exist does the
 * write fall back to the legacy flat `~/.polygraph/sidecars/<sessionId>/`
 * dir — for real sessions nothing new lands under the flat dir.
 *
 * @param {object} opts
 * @param {string} opts.agentType         'claude' | 'codex'
 * @param {string} opts.agentSessionId    The harness's own session id.
 * @param {string} opts.polygraphSessionId Value of POLYGRAPH_SESSION_ID.
 * @param {string} opts.cwd               Agent working directory.
 * @param {string} [opts.transcriptPath]  Absolute transcript path; omit when unknown.
 * @param {number} [opts.pid]             Harness process id; omit when not knowable.
 * @param {string} [home]                 Override HOME for testing.
 */
export function writeCaptureMapping(
  { agentType, agentSessionId, polygraphSessionId, cwd, transcriptPath, pid },
  home = process.env.HOME?.trim() || homedir()
) {
  const filenamePart = sanitizeFilename(`${agentType}-${agentSessionId}`);
  const fileName = `mapping-${filenamePart}.json`;

  const sessionDir = join(sessionsRoot(home), polygraphSessionId);
  const sessionSidecarDir = join(sessionDir, 'sidecars');
  const legacyDir = join(home, '.polygraph', 'sidecars', polygraphSessionId);

  // New location when the session directory exists; legacy flat dir only
  // when it does not.
  const targetDir = existsSync(sessionDir) ? sessionSidecarDir : legacyDir;
  mkdirSync(targetDir, { recursive: true });

  const finalPath = join(targetDir, fileName);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;

  const now = Date.now();

  // Refresh semantics: preserve firstSeenAt from a valid prior mapping.
  // Check the new location first, then the legacy flat dir — this keeps
  // firstSeenAt continuity when migrating a mapping from the legacy dir.
  let firstSeenAt = now;
  for (const candidate of [
    join(sessionSidecarDir, fileName),
    join(legacyDir, fileName),
  ]) {
    if (!existsSync(candidate)) continue;
    const existing = tryParseJson(readFileSync(candidate, 'utf8'));
    if (
      existing !== null &&
      existing.version === 1 &&
      existing.polygraphSessionId === polygraphSessionId &&
      existing.agentSessionId === agentSessionId &&
      Number.isFinite(existing.firstSeenAt)
    ) {
      firstSeenAt = existing.firstSeenAt;
      break;
    }
  }

  const mapping = {
    version: 1,
    polygraphSessionId,
    agentType,
    agentSessionId,
    cwd,
    ...(transcriptPath != null ? { transcriptPath } : {}),
    ...(pid != null ? { pid } : {}),
    source: 'hook',
    firstSeenAt,
    lastSeenAt: now,
  };

  writeFileSync(tmpPath, JSON.stringify(mapping, null, 2) + '\n');
  renameSync(tmpPath, finalPath);
}

export function main() {
  try {
    const polygraphSessionId = process.env.POLYGRAPH_SESSION_ID;
    if (!polygraphSessionId) return;
    if (process.env.POLYGRAPH_CHILD_AGENT) return;

    const agentType = process.argv[2];
    if (!agentType) return;

    let payload = {};
    const raw = readStdin();
    if (raw) {
      const parsed = tryParseJson(raw);
      if (parsed !== null) payload = parsed;
    }

    const agentSessionId =
      typeof payload.session_id === 'string' ? payload.session_id : '';
    if (!agentSessionId) return;

    const cwd =
      typeof payload.cwd === 'string' && payload.cwd
        ? payload.cwd
        : process.cwd();

    // transcript_path is present on Claude/Codex payloads; may be null — omit
    // the field when absent or null rather than writing null into the mapping.
    const transcriptPath =
      typeof payload.transcript_path === 'string' && payload.transcript_path
        ? payload.transcript_path
        : undefined;

    writeCaptureMapping({
      agentType,
      agentSessionId,
      polygraphSessionId,
      cwd,
      transcriptPath,
      // process.ppid is the harness pid when the hook is spawned as a child.
      pid: process.ppid,
    });
  } catch (error) {
    // Silent toward the agent — a broken hook must never break the session —
    // but record it so failures are not invisible.
    logHookFailure(`${process.argv[2] || 'unknown'}:record-session-mapping`, error);
  }
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
