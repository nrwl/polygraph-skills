// Remind agents to use subagents for delegation and polling.
// Outputs a non-blocking systemMessage — does not prevent the tool call.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin } from 'node:process';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

// Append a one-line JSON record of a hook failure to ~/.polygraph/logs/hooks.log.
// This hook must never write anything to stdout except its hookSpecificOutput
// payload, so this on-disk log is the only record that something went wrong.
// The logger is itself failure-proof.
function logHookFailure(
  hook,
  error,
  meta = {},
  home = process.env.HOME?.trim() || homedir()
) {
  try {
    const logsDir = join(home, '.polygraph', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, 'hooks.log');

    try {
      if (statSync(logFile).size > HOOK_LOG_MAX_BYTES) {
        renameSync(logFile, `${logFile}.1`);
      }
    } catch {
      // no prior log, or rotation failed — ignore
    }

    const entry = {
      time: new Date().toISOString(),
      hook,
      pid: process.pid,
      ...meta,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    appendFileSync(logFile, JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never throw — a failing logger must not break the hook.
  }
}

try {
  // Consume stdin (hook protocol requires it)
  stdin.resume();
  stdin.on('end', () => {});

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        systemMessage:
          'REMINDER: spawn_agent and show_agent should be called via background subagents (polygraph-delegate-subagent), not directly. Direct calls flood the context window with polling noise. If you are already inside a subagent, ignore this reminder.',
      },
    })
  );
} catch (error) {
  logHookFailure('remind-subagents', error);
}
