import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const LAUNCH_ERROR_CODES = new Set(['EACCES', 'EINVAL', 'ENOENT', 'ENOEXEC']);

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
  return spawn(command, args, boundedOptions);
}

function isLaunchFailure(result) {
  return Boolean(result?.error && LAUNCH_ERROR_CODES.has(result.error.code));
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
  const executable = reexec?.[0] ?? command;
  const prefixArgs = reexec?.slice(1) ?? [];
  const spawnOptions = {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    cwd: nonEmptyString(cwd) ?? process.cwd(),
    env: captureCommandEnvironment(env),
    shell: false,
    windowsHide: true,
  };

  let result = runBeforeDeadline(
    spawn,
    executable,
    [...prefixArgs, ...args],
    spawnOptions,
    deadline,
    now
  );

  // Match the shared link hook's current fallback: a plain JavaScript CLI
  // entry may lack an executable bit or be unlaunchable on this platform.
  // A timed out or otherwise ambiguous process is never retried: it may have
  // already changed capture state before it was terminated.
  if (isLaunchFailure(result) && /\.[cm]?js$/i.test(executable)) {
    result = runBeforeDeadline(
      spawn,
      nodeRuntime(execPath),
      [executable, ...prefixArgs, ...args],
      spawnOptions,
      deadline,
      now
    );
  }

  return result;
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
