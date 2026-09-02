import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const JS_CLI_ENTRY = /\.[cm]?js$/i;

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function isManagedChildEnvironment(env) {
  return Boolean(env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT'));
}

export function captureCommandEnvironment(env = process.env) {
  const commandEnv = { ...env };
  delete commandEnv.POLYGRAPH_SESSION_ID;
  delete commandEnv.POLYGRAPH_CAPTURE_TOKEN;
  return commandEnv;
}

function nodeRuntime(execPath) {
  const base = basename(execPath).toLowerCase();
  return base === 'node' || base === 'node.exe' ? execPath : 'node';
}

function portableReexec(env, platform) {
  const raw = nonEmptyString(env.POLYGRAPH_CLI_REEXEC);
  if (!raw || platform !== 'win32') return undefined;

  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((part) => nonEmptyString(part))
    ) {
      return parsed;
    }
  } catch {
    // An invalid portability hint is ignored in favor of the normal launch.
  }
  return undefined;
}

function deadlineExceededResult() {
  const error = new Error('Polygraph capture command timed out before launch');
  error.code = 'ETIMEDOUT';
  return { error, status: null, signal: 'SIGTERM' };
}

function withRemainingTimeout(options, deadline, now) {
  if (deadline === undefined) return options;
  const remaining = Math.floor(deadline - now());
  if (remaining < 1) return undefined;
  const configured = Number.isFinite(options.timeout) ? options.timeout : remaining;
  return { ...options, timeout: Math.min(configured, remaining) };
}

function runBeforeDeadline(spawn, command, args, options, deadline, now) {
  const boundedOptions = withRemainingTimeout(options, deadline, now);
  if (!boundedOptions) return deadlineExceededResult();
  // Some runtimes hosting these hooks in-process (OpenCode runs under Bun)
  // THROW launch errors from spawnSync instead of returning them in
  // result.error. Both shapes must land in the same error path.
  try {
    return spawn(command, args, boundedOptions);
  } catch (error) {
    return { error, status: null, signal: null };
  }
}

export function runCaptureCliSync(
  args,
  {
    env = process.env,
    spawn = spawnSync,
    options = {},
    cwd = process.cwd(),
    deadline,
    now = Date.now,
    platform = process.platform,
    execPath = process.execPath,
  } = {}
) {
  const command = nonEmptyString(env.POLYGRAPH_CLI) ?? 'polygraph';
  const reexec = portableReexec(env, platform);
  const spawnOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    cwd: nonEmptyString(cwd) ?? process.cwd(),
    env: captureCommandEnvironment(env),
    shell: false,
    windowsHide: true,
  };

  // A plain JavaScript CLI entry (a local package install, a dev build without
  // the executable bit) is never executed directly: direct execution fails
  // EACCES/ENOEXEC on most platforms and Bun surfaces that as a synchronous
  // throw. Running it through Node up front means exactly one process ever
  // launches per wake — there is no ambiguity about which attempt ran.
  let executable;
  let prefixArgs;
  if (reexec) {
    [executable, ...prefixArgs] = reexec;
  } else if (JS_CLI_ENTRY.test(command)) {
    executable = nodeRuntime(execPath);
    prefixArgs = [command];
  } else {
    executable = command;
    prefixArgs = [];
  }

  return runBeforeDeadline(
    spawn,
    executable,
    [...prefixArgs, ...args],
    spawnOptions,
    deadline,
    now
  );
}

function reportWorkerLaunchFailure(onFailure, error) {
  try {
    const pending = onFailure(error);
    if (pending && typeof pending.catch === 'function') {
      pending.catch(() => {});
    }
  } catch {
    // A detached handoff must never turn diagnostics into a hook failure.
  }
}

function openHookWorkerLog(env, logName) {
  const home = nonEmptyString(env?.HOME) ?? homedir();
  const logsDir = join(home, '.polygraph', 'logs');
  mkdirSync(logsDir, { recursive: true });
  return openSync(join(logsDir, logName), 'a', 0o600);
}

/**
 * Hand a serialized claim to a detached Node worker and return immediately.
 * The worker owns the complete CLI invocation and its durable failure
 * logging; the short-lived parent hook observes launch errors only, because
 * it cannot outlive the harness event that spawned it.
 *
 * The worker is a plain JS module, so it always launches through a Node
 * runtime: process.execPath is the host binary, and under OpenCode that is
 * the compiled Bun executable rather than Node.
 */
export function launchDetachedHookWorker({
  workerPath,
  claim,
  logName,
  spawn = spawnChild,
  env = process.env,
  execPath = process.execPath,
  onFailure = () => {},
  openLog = openHookWorkerLog,
  closeLog = closeSync,
}) {
  const logFd = openLog(env, logName);
  let child;
  try {
    child = spawn(nodeRuntime(execPath), [workerPath, JSON.stringify(claim)], {
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
      reportWorkerLaunchFailure(onFailure, error);
    }
  }

  child.once('error', (error) => reportWorkerLaunchFailure(onFailure, error));
  child.unref();

  return true;
}

export function cliFailure(commandName, result) {
  if (result?.error) return result.error;
  const stderr = nonEmptyString(result?.stderr);
  const stdout = nonEmptyString(result?.stdout);
  const detail = stderr ?? stdout;
  const outcome = result?.signal
    ? `terminated by signal ${result.signal}`
    : `exited with status ${String(result?.status)}`;
  return new Error(
    `polygraph ${commandName} ${outcome}` +
      (detail ? `: ${detail}` : '')
  );
}
