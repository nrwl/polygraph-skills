import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const JS_CLI_ENTRY = /\.[cm]?js$/i;
export const HOOK_WORKER_LOG_MAX_BYTES = 5 * 1024 * 1024;

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

/**
 * The directory a capture process is launched from. A claim carries the
 * harness working directory, but that directory can be gone by the time a
 * delayed hook or detached worker runs (an archived session worktree, a
 * removed temp dir), and a spawn from a missing cwd fails with ENOENT before
 * the CLI ever starts. Working-directory evidence reaches the CLI as an
 * explicit `--cwd` argument where it matters, so the launch itself only
 * needs a directory that exists: the claim's own when it does, else the home
 * directory, else the temp directory.
 */
export function resolveLaunchDirectory(preferred, env = process.env) {
  const candidates = [preferred, nonEmptyString(env?.HOME) ?? homedir(), tmpdir()];
  for (const candidate of candidates) {
    const directory = nonEmptyString(candidate);
    if (!directory) continue;
    try {
      if (statSync(directory).isDirectory()) return directory;
    } catch {
      // Missing or unreadable: try the next candidate.
    }
  }
  return undefined;
}

/**
 * The hook process's own working directory, or undefined when it no longer
 * has one. A harness can start a hook in a directory removed moments earlier
 * or remove it while the hook runs, and `process.cwd()` then throws
 * `uv_cwd`. Callers use this only as the last-resort claim directory, so a
 * missing answer degrades to the launch fallback instead of a crash.
 */
export function processWorkingDirectory() {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/**
 * The working directory a claim may record when the payload carries none.
 * Claude and Codex run command hooks in the session's own directory, so the
 * hook process's cwd is genuine harness evidence there. Cursor runs plugin
 * hooks from the plugin root, which is never the repository: a Cursor claim
 * without workspace_roots records no directory at all, and the launch
 * fallback (home, then temp) stays a spawn detail rather than evidence.
 */
export function fallbackClaimDirectory(agentType, hookCwd) {
  if (agentType === 'cursor') return undefined;
  return nonEmptyString(hookCwd) ?? processWorkingDirectory();
}

/**
 * A hook-captured observation time: a positive epoch-millisecond integer, or
 * undefined for anything else. Wakes and finalizations both carry one, and
 * neither ever substitutes a worker's own clock for it.
 */
export function observedAtValue(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
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
    cwd,
    deadline,
    now = Date.now,
    platform = process.platform,
    execPath = process.execPath,
  } = {}
) {
  const command = nonEmptyString(env.POLYGRAPH_CLI) ?? 'polygraph';
  const reexec = portableReexec(env, platform);
  const launchDirectory = resolveLaunchDirectory(cwd, env);
  const spawnOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    ...(launchDirectory ? { cwd: launchDirectory } : {}),
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

// A worker's inherited stdout/stderr land in one append-only log per worker
// kind, rotated to `.1` past the same bound as hooks.log so a chatty CLI can
// never grow it without limit.
export function openHookWorkerLog(env, logName) {
  const home = nonEmptyString(env?.HOME) ?? homedir();
  const logsDir = join(home, '.polygraph', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, logName);

  try {
    if (statSync(logFile).size > HOOK_WORKER_LOG_MAX_BYTES) {
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // There may be no prior log, and rotation must stay best-effort.
  }

  return openSync(logFile, 'a', 0o600);
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
  // The log is diagnostic only. If it cannot be opened (unwritable home,
  // exhausted descriptors) the worker still launches with its output
  // discarded; its own durable hooks.log write does not depend on it.
  let logFd;
  try {
    logFd = openLog(env, logName);
  } catch (error) {
    reportWorkerLaunchFailure(onFailure, error);
  }
  const output = logFd === undefined ? 'ignore' : logFd;

  // The serialized claim keeps the harness cwd as evidence even when the
  // launch has to happen elsewhere.
  const launchDirectory = resolveLaunchDirectory(claim.cwd, env);

  let child;
  try {
    child = spawn(nodeRuntime(execPath), [workerPath, JSON.stringify(claim)], {
      ...(launchDirectory ? { cwd: launchDirectory } : {}),
      detached: true,
      env: captureCommandEnvironment(env),
      shell: false,
      stdio: ['ignore', output, output],
      windowsHide: true,
    });
  } finally {
    if (logFd !== undefined) {
      try {
        closeLog(logFd);
      } catch (error) {
        reportWorkerLaunchFailure(onFailure, error);
      }
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
