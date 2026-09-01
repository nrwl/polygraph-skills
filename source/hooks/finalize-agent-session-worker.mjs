import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { finalizeAgentSession } from './agent-session-finalize.mjs';
import { logHookFailure } from './agent-session-link.mjs';

function writeWorkerFailure(error, claim) {
  try {
    const entry = {
      time: new Date().toISOString(),
      hook: 'claude:finalize-agent-session-worker',
      pid: process.pid,
      agentSessionId: claim?.agentSessionId,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {
    // The inherited log stream is diagnostic only.
  }
}

export function main({
  serializedClaim = process.argv[2],
  env = process.env,
  spawn,
  logFailure = logHookFailure,
  writeFailure = writeWorkerFailure,
} = {}) {
  let claim;
  try {
    claim = JSON.parse(serializedClaim);
    return finalizeAgentSession(claim, spawn, env);
  } catch (error) {
    writeFailure(error, claim);
    try {
      logFailure('claude:finalize-agent-session-worker', error, {
        agentSessionId: claim?.agentSessionId,
        cli: env.POLYGRAPH_CLI || 'polygraph',
      });
    } catch {
      // The worker is already detached; diagnostics cannot be allowed to crash it.
    }
    return false;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main() ? 0 : 1;
}
