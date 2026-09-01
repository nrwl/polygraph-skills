import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureCommandEnvironment,
  cliFailure,
  isManagedChildEnvironment,
  nonEmptyString,
  runCaptureCliSync,
} from './capture-cli.mjs';

const FINALIZE_WORKER_PATH = fileURLToPath(
  new URL('./finalize-agent-session-worker.mjs', import.meta.url)
);

function openFinalizeLog(env) {
  const home = nonEmptyString(env?.HOME) ?? homedir();
  const logsDir = join(home, '.polygraph', 'logs');
  mkdirSync(logsDir, { recursive: true });
  return openSync(join(logsDir, 'session-finalize.log'), 'a', 0o600);
}

function reportFailure(onFailure, error) {
  try {
    const pending = onFailure(error);
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => {});
    }
  } catch {
    // A detached handoff must never turn diagnostics into a hook failure.
  }
}

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
  spawn = spawnChild,
  env = process.env,
  {
    workerPath = FINALIZE_WORKER_PATH,
    execPath = process.execPath,
    onFailure = () => {},
    openLog = openFinalizeLog,
    closeLog = closeSync,
  } = {}
) {
  if (isManagedChildEnvironment(env)) return false;

  const logFd = openLog(env);
  let child;
  try {
    child = spawn(execPath, [workerPath, JSON.stringify(claim)], {
      cwd: nonEmptyString(claim.cwd) ?? process.cwd(),
      detached: true,
      env: captureCommandEnvironment(env),
      shell: false,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
  } finally {
    try {
      closeLog(logFd);
    } catch (error) {
      reportFailure(onFailure, error);
    }
  }

  // This only covers failure to launch the durable worker. CLI exit handling
  // belongs to the worker and never depends on this unref'd parent process.
  child.once('error', (error) => reportFailure(onFailure, error));
  child.unref();

  return true;
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
