import { spawnSync } from 'node:child_process';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isManagedChildEnvironment(env) {
  return Boolean(env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT'));
}

export function buildEnsureAgentSessionCaptureArgs({
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
}) {
  const harnessSession = nonEmptyString(agentSessionId);
  if (agentType !== 'claude') throw new Error(`Unsupported agent type: ${agentType}`);
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

export function ensureAgentSessionCapture(claim, spawn = spawnSync, env = process.env) {
  if (isManagedChildEnvironment(env)) return false;

  const command = nonEmptyString(env?.POLYGRAPH_CLI) ?? 'polygraph';
  const commandEnv = { ...env };
  delete commandEnv.POLYGRAPH_SESSION_ID;
  delete commandEnv.POLYGRAPH_CAPTURE_TOKEN;

  const result = spawn(command, buildEnsureAgentSessionCaptureArgs(claim), {
    encoding: 'utf8',
    env: commandEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = nonEmptyString(result?.stderr);
    throw new Error(
      `polygraph _ensure-agent-session-capture exited with status ${String(result?.status)}` +
        (detail ? `: ${detail}` : '')
    );
  }

  return true;
}

export function buildCommandHookEnsureCapture(payload, agentType, env = process.env) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  if (isManagedChildEnvironment(env)) return undefined;
  if (agentType !== 'claude' || payload.hook_event_name !== 'Stop') {
    return undefined;
  }

  const agentSessionId = nonEmptyString(payload.session_id);
  if (!agentSessionId) return undefined;

  return {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd),
    transcriptPath: nonEmptyString(payload.transcript_path),
  };
}
