import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  cliFailure,
  isManagedChildEnvironment,
  launchDetachedHookWorker,
  nonEmptyString,
  observedAtValue,
  runCaptureCliSync,
} from './capture-cli.mjs';

export const FINALIZE_TIMEOUT_MS = 90_000;

const FINALIZE_AGENT_TYPES = new Set(['claude', 'cursor']);

// The one lifecycle event per harness that means the conversation ended.
// Claude sends PascalCase, Cursor camelCase. Codex documents a SessionEnd
// hook but is deliberately not wired: Ocean's finalize command accepts only
// Claude and Cursor sessions, so a Codex finalize must land there first.
// OpenCode exposes no session-exit event at all.
const FINALIZE_EVENTS_BY_AGENT = {
  claude: 'SessionEnd',
  cursor: 'sessionEnd',
};

const FINALIZE_WORKER_PATH = fileURLToPath(
  new URL('./finalize-agent-session-worker.mjs', import.meta.url)
);

// The finalize command carries identity, the mutable path evidence,
// `--source`, and the moment the session-end hook fired. Ocean compares that
// observation against the mapping's last-seen time and ignores a finalize
// that predates a later wake or relink, so it must be the hook's own clock
// reading, never the detached worker's start time: a finalize worker may run
// up to 90 seconds after the harness exit it describes.
export function buildFinalizeAgentSessionArgs({
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
  source,
  observedAt,
}) {
  const harnessSession = nonEmptyString(agentSessionId);
  const hookSource = nonEmptyString(source);
  const observed = observedAtValue(observedAt);
  if (!FINALIZE_AGENT_TYPES.has(agentType)) {
    throw new Error(`Unsupported agent type: ${agentType}`);
  }
  if (!harnessSession) throw new Error('agentSessionId is required');
  if (!hookSource) throw new Error('source is required');
  if (observed === undefined) {
    throw new Error('observedAt is required: a finalize must carry the hook-captured time');
  }

  const args = [
    '_finalize-agent-session',
    '--agent-type',
    agentType,
    '--agent-session-id',
    harnessSession,
  ];

  const workingDirectory = nonEmptyString(cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  args.push('--source', hookSource, '--observed-at', String(observed));
  return args;
}

export function finalizeAgentSession(
  claim,
  spawn = spawnSync,
  env = process.env,
  runnerOptions = {}
) {
  if (isManagedChildEnvironment(env)) return false;

  const {
    options = {},
    timeoutMs = FINALIZE_TIMEOUT_MS,
    now = Date.now,
    ...runOptions
  } = runnerOptions;
  const boundedTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(Math.floor(timeoutMs), FINALIZE_TIMEOUT_MS)
      : FINALIZE_TIMEOUT_MS;
  const deadline = now() + boundedTimeout;
  const result = runCaptureCliSync(buildFinalizeAgentSessionArgs(claim), {
    ...runOptions,
    env,
    spawn,
    cwd: claim.cwd,
    deadline,
    now,
    options: {
      ...options,
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
    },
  });

  if (result?.error || result?.status !== 0) {
    throw cliFailure('_finalize-agent-session', result);
  }

  return true;
}

export function launchAgentSessionFinalize(
  claim,
  spawn,
  env = process.env,
  { workerPath = FINALIZE_WORKER_PATH, ...workerOptions } = {}
) {
  if (isManagedChildEnvironment(env)) return false;

  return launchDetachedHookWorker({
    logName: 'session-finalize.log',
    ...workerOptions,
    workerPath,
    claim,
    ...(spawn ? { spawn } : {}),
    env,
  });
}

export function buildCommandHookFinalize(
  payload,
  agentType,
  env = process.env,
  now = Date.now
) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  if (isManagedChildEnvironment(env)) return undefined;
  if (FINALIZE_EVENTS_BY_AGENT[agentType] !== payload.hook_event_name) {
    return undefined;
  }

  // Cursor payloads carry the id in both session_id and conversation_id and
  // have no top-level cwd; workspace_roots[0] is the launch directory. The
  // end reason and final status stay behind: the transcript alone decides
  // what the final answer was. No finalize claim ever carries a PID.
  const agentSessionId =
    nonEmptyString(payload.session_id) ??
    (agentType === 'cursor' ? nonEmptyString(payload.conversation_id) : undefined);
  if (!agentSessionId) return undefined;

  const workspaceRoot =
    agentType === 'cursor' && Array.isArray(payload.workspace_roots)
      ? nonEmptyString(payload.workspace_roots[0])
      : undefined;

  // The observation time is read here, synchronously in the hook process,
  // before the worker detaches.
  return {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd) ?? workspaceRoot,
    transcriptPath: nonEmptyString(payload.transcript_path),
    source: 'hook',
    observedAt: now(),
  };
}
