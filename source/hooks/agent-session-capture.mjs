import { spawnSync } from 'node:child_process';
import {
  cliFailure,
  isManagedChildEnvironment,
  nonEmptyString,
  runCaptureCliSync,
} from './capture-cli.mjs';

export const ENSURE_CAPTURE_TIMEOUT_MS = 5_000;
export const ENSURE_CAPTURE_UNSUPPORTED_MARKER =
  'POLYGRAPH_ENSURE_AGENT_SESSION_CAPTURE_UNSUPPORTED';

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
  source,
}) {
  const harnessSession = nonEmptyString(agentSessionId);
  const hookSource = nonEmptyString(source);
  if (agentType !== 'claude') throw new Error(`Unsupported agent type: ${agentType}`);
  if (!harnessSession) throw new Error('agentSessionId is required');
  if (!hookSource) throw new Error('source is required');

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

  args.push('--source', hookSource);
  return args;
}

export function buildLegacyCaptureWakeArgs(claim) {
  const ensureArgs = buildEnsureAgentSessionCaptureArgs(claim);
  return ['_link-agent-session', ...ensureArgs.slice(1)];
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

export function buildCommandHookEnsureCapture(payload, agentType, env = process.env) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  if (isManagedChildEnvironment(env)) return undefined;
  if (
    agentType !== 'claude' ||
    !['Stop', 'UserPromptSubmit'].includes(payload.hook_event_name)
  ) {
    return undefined;
  }

  const agentSessionId = nonEmptyString(payload.session_id);
  if (!agentSessionId) return undefined;

  return {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd),
    transcriptPath: nonEmptyString(payload.transcript_path),
    source: 'hook',
  };
}
