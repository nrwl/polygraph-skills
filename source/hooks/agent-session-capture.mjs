import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  cliFailure,
  isManagedChildEnvironment,
  launchDetachedHookWorker,
  nonEmptyString,
  runCaptureCliSync,
} from './capture-cli.mjs';

export const ENSURE_CAPTURE_TIMEOUT_MS = 5_000;
export const ENSURE_CAPTURE_UNSUPPORTED_MARKER =
  'POLYGRAPH_ENSURE_AGENT_SESSION_CAPTURE_UNSUPPORTED';

const WAKE_AGENT_TYPES = new Set(['claude', 'codex', 'opencode', 'cursor']);

// Every wake event is capture liveness only. Which harness event fired, and
// in which order, is never forwarded: the transcript alone carries step
// semantics, so both the prompt-submit and the agent-done wake of a harness
// produce the identical identity-only invocation.
const WAKE_EVENTS_BY_AGENT = {
  claude: new Set(['UserPromptSubmit', 'Stop']),
  codex: new Set(['UserPromptSubmit', 'Stop']),
  cursor: new Set(['beforeSubmitPrompt', 'stop']),
};

const ENSURE_WAKE_WORKER_PATH = fileURLToPath(
  new URL('./ensure-agent-session-capture-worker.mjs', import.meta.url)
);

function boundedEnsureTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return ENSURE_CAPTURE_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), ENSURE_CAPTURE_TIMEOUT_MS);
}

export function buildEnsureAgentSessionCaptureArgs({
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
}) {
  const harnessSession = nonEmptyString(agentSessionId);
  if (!WAKE_AGENT_TYPES.has(agentType)) {
    throw new Error(`Unsupported agent type: ${agentType}`);
  }
  if (!harnessSession) throw new Error('agentSessionId is required');

  const args = [
    '_ensure-agent-session-capture',
    '--agent-type',
    agentType,
    '--agent-session-id',
    harnessSession,
  ];

  const workingDirectory = nonEmptyString(cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  return args;
}

// The legacy identity-only mapping command keeps its `--source` because the
// mapping it records carries provenance; the preferred ensure command above
// deliberately does not, since a liveness poke has none.
export function buildLegacyCaptureWakeArgs(claim) {
  const ensureArgs = buildEnsureAgentSessionCaptureArgs(claim);
  return ['_link-agent-session', ...ensureArgs.slice(1), '--source', 'hook'];
}

function commandUnavailable(result) {
  if (result?.error) return false;
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return (
    output.includes(ENSURE_CAPTURE_UNSUPPORTED_MARKER) ||
    /(?:unknown (?:argument|command)|command not found)[^\n]*_ensure-agent-session-capture\b/i.test(
      output
    ) ||
    /_ensure-agent-session-capture\b[^\n]*(?:is not a command|not found)/i.test(
      output
    )
  );
}

export function ensureAgentSessionCapture(
  claim,
  spawn = spawnSync,
  env = process.env,
  {
    timeoutMs = ENSURE_CAPTURE_TIMEOUT_MS,
    now = Date.now,
    platform = process.platform,
    execPath = process.execPath,
  } = {}
) {
  if (isManagedChildEnvironment(env)) return false;

  const deadline = now() + boundedEnsureTimeout(timeoutMs);
  const options = {
    killSignal: 'SIGKILL',
    maxBuffer: 256 * 1024,
  };
  const run = (args) =>
    runCaptureCliSync(args, {
      env,
      spawn,
      options,
      cwd: claim.cwd,
      deadline,
      now,
      platform,
      execPath,
    });

  const result = run(buildEnsureAgentSessionCaptureArgs(claim));
  if (!result?.error && result?.status === 0) return true;

  if (commandUnavailable(result)) {
    const fallback = run(buildLegacyCaptureWakeArgs(claim));
    if (!fallback?.error && fallback?.status === 0) return true;
    throw cliFailure('_link-agent-session compatibility fallback', fallback);
  }

  throw cliFailure('_ensure-agent-session-capture', result);
}

export function launchAgentSessionCaptureWake(
  claim,
  spawn,
  env = process.env,
  { onFailure = () => {}, ...workerOptions } = {}
) {
  if (isManagedChildEnvironment(env)) return false;

  return launchDetachedHookWorker({
    workerPath: ENSURE_WAKE_WORKER_PATH,
    logName: 'capture-wake.log',
    ...workerOptions,
    claim,
    ...(spawn ? { spawn } : {}),
    env,
    onFailure,
  });
}

export function buildCommandHookEnsureCapture(payload, agentType, env = process.env) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  if (isManagedChildEnvironment(env)) return undefined;

  const wakeEvents = WAKE_EVENTS_BY_AGENT[agentType];
  if (!wakeEvents?.has(payload.hook_event_name)) return undefined;

  // Cursor payloads carry the id in both session_id and conversation_id and
  // have no top-level cwd; workspace_roots[0] is the launch directory.
  const agentSessionId =
    nonEmptyString(payload.session_id) ??
    (agentType === 'cursor' ? nonEmptyString(payload.conversation_id) : undefined);
  if (!agentSessionId) return undefined;

  const workspaceRoot =
    agentType === 'cursor' && Array.isArray(payload.workspace_roots)
      ? nonEmptyString(payload.workspace_roots[0])
      : undefined;

  return {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd) ?? workspaceRoot,
    transcriptPath: nonEmptyString(payload.transcript_path),
  };
}
