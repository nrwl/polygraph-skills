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

// Ocean may spend up to 2.5 seconds waiting for its singleton startup lock and
// 10 seconds on the sidecar handshake. Keep enough headroom for CLI startup
// while retaining one bounded deadline across ensure and its legacy fallback.
export const ENSURE_CAPTURE_TIMEOUT_MS = 20_000;
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
  // afterAgentResponse fires per completed assistant message, so one Cursor
  // turn may wake several times; every wake is the same idempotent poke and
  // the message text it carries is never forwarded.
  cursor: new Set(['beforeSubmitPrompt', 'afterAgentResponse', 'stop']),
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

function wakeIdentityArgs({ agentType, agentSessionId }) {
  const harnessSession = nonEmptyString(agentSessionId);
  if (!WAKE_AGENT_TYPES.has(agentType)) {
    throw new Error(`Unsupported agent type: ${agentType}`);
  }
  if (!harnessSession) throw new Error('agentSessionId is required');

  return ['--agent-type', agentType, '--agent-session-id', harnessSession];
}

// The ensure command carries stable harness identity plus the moment the
// hook fired. Ocean refreshes the exact mapping and compares terminal-marker
// freshness against that timestamp, so it must be the hook's own clock
// reading, never the detached worker's start time: a delayed worker cannot
// present its startup as evidence that the harness was still live.
export function buildEnsureAgentSessionCaptureArgs({
  agentType,
  agentSessionId,
  observedAt,
}) {
  const identity = wakeIdentityArgs({ agentType, agentSessionId });
  const observed = observedAtValue(observedAt);
  if (observed === undefined) {
    throw new Error('observedAt is required: a wake must carry the hook-captured time');
  }

  return [
    '_ensure-agent-session-capture',
    ...identity,
    '--observed-at',
    String(observed),
  ];
}

// The legacy mapping command keeps its mutable path evidence and `--source`
// provenance and never carries `--observed-at`. The preferred ensure command
// above deliberately carries only stable harness identity so a cwd or
// transcript-path change cannot narrow a liveness lookup to zero mappings.
export function buildLegacyCaptureWakeArgs(claim) {
  const args = ['_link-agent-session', ...wakeIdentityArgs(claim)];

  const workingDirectory = nonEmptyString(claim.cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(claim.transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  args.push('--source', 'hook');
  return args;
}

function commandUnavailable(result) {
  if (result?.error) return false;
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  if (output.includes(ENSURE_CAPTURE_UNSUPPORTED_MARKER)) return true;

  // Shell 0.1.x prints the root usage to stdout and reports every token as an
  // unknown argument. Match that complete, observed failure shape rather than
  // treating an arbitrary error that happens to mention the hidden command as
  // evidence of version skew.
  const stdout =
    typeof result?.stdout === 'string'
      ? result.stdout.replace(/\r\n/g, '\n')
      : '';
  return (
    result?.status === 1 &&
    !nonEmptyString(result?.stderr) &&
    stdout.startsWith('Usage: polygraph\n') &&
    stdout.includes('\nValidation failed for one or more options\n') &&
    stdout.includes('\n  - Unknown argument: _ensure-agent-session-capture\n')
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

export function buildCommandHookEnsureCapture(
  payload,
  agentType,
  env = process.env,
  now = Date.now
) {
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

  // Captured here, synchronously in the hook process, before any detach.
  return {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd) ?? workspaceRoot,
    transcriptPath: nonEmptyString(payload.transcript_path),
    observedAt: now(),
  };
}
