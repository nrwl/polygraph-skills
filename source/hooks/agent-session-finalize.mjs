import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  cliFailure,
  isManagedChildEnvironment,
  launchDetachedHookWorker,
  nonEmptyString,
  runCaptureCliSync,
} from './capture-cli.mjs';

const FINALIZE_WORKER_PATH = fileURLToPath(
  new URL('./finalize-agent-session-worker.mjs', import.meta.url)
);

export function buildFinalizeAgentSessionArgs({
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

  args.push('--source', hookSource);
  return args;
}

export function finalizeAgentSession(
  claim,
  spawn = spawnSync,
  env = process.env,
  runnerOptions = {}
) {
  if (isManagedChildEnvironment(env)) return false;

  const { options = {}, ...runOptions } = runnerOptions;
  const result = runCaptureCliSync(buildFinalizeAgentSessionArgs(claim), {
    ...runOptions,
    env,
    spawn,
    cwd: claim.cwd,
    options: {
      ...options,
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

export function buildCommandHookFinalize(payload, agentType, env = process.env) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (isManagedChildEnvironment(env)) return undefined;
  if (agentType !== 'claude' || payload.hook_event_name !== 'SessionEnd') {
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
