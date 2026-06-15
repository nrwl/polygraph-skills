// Hidden SessionStart hook — records an agent-capture mapping file that binds
// this agent's session id to the Polygraph session id in the environment.
// Used by both the Claude Code plugin (agentType=claude) and the Codex plugin
// (agentType=codex). The agentType is passed as the first CLI argument so the
// same script ships in both plugin artifacts.
//
// File contract (must match the Polygraph CLI reader exactly):
//   ~/.polygraph/sidecars/<POLYGRAPH_SESSION_ID>/mapping-<agentType>-<agentSessionId>.json
//
// Behaviour:
//   - Silent no-op when POLYGRAPH_SESSION_ID is unset.
//   - Silent no-op when POLYGRAPH_CHILD_AGENT is set (child agents must not
//     register themselves as parents).
//   - Atomic write: write to <path>.tmp-<pid>, then rename over final path.
//   - Refresh: when a valid prior mapping for the same session already exists,
//     preserve its firstSeenAt and only update lastSeenAt + mutable fields.
//   - All failures are silently swallowed; never writes to stdout (Claude Code
//     injects hook stdout into the model context); never exits non-zero.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Write (or refresh) the agent-capture mapping file.
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
  const sidecarDir = join(home, '.polygraph', 'sidecars', polygraphSessionId);
  mkdirSync(sidecarDir, { recursive: true });

  const filenamePart = sanitizeFilename(`${agentType}-${agentSessionId}`);
  const finalPath = join(sidecarDir, `mapping-${filenamePart}.json`);
  const tmpPath = `${finalPath}.tmp-${process.pid}`;

  const now = Date.now();

  // Refresh semantics: preserve firstSeenAt from a valid prior mapping.
  let firstSeenAt = now;
  if (existsSync(finalPath)) {
    const existing = tryParseJson(readFileSync(finalPath, 'utf8'));
    if (
      existing !== null &&
      existing.version === 1 &&
      existing.polygraphSessionId === polygraphSessionId &&
      existing.agentSessionId === agentSessionId &&
      Number.isFinite(existing.firstSeenAt)
    ) {
      firstSeenAt = existing.firstSeenAt;
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
  } catch {
    // Silent — a broken hook must never break the agent session.
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
