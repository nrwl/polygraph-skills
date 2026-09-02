import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookEnsureCapture,
  ensureAgentSessionCapture,
  launchAgentSessionCaptureWake,
} from './agent-session-capture.mjs';
import { logHookFailure } from './agent-session-link.mjs';

function readPayload() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function main({
  payload = readPayload(),
  agentType = process.argv[2],
  // Harness manifests without an async hook flag pass --detach so the hook
  // returns immediately; a detached worker then owns the bounded wake. This
  // matters most for cursor's blocking beforeSubmitPrompt, which would
  // otherwise stall every prompt on a slow CLI.
  detach = process.argv.includes('--detach'),
  env = process.env,
  spawn,
  logFailure = logHookFailure,
  cwd = process.cwd(),
  launcherOptions = {},
  now = Date.now,
} = {}) {
  const reportFailure = (error) =>
    logFailure(`${agentType || 'unknown'}:ensure-agent-session-capture`, error, {
      hookEventName: payload?.hook_event_name,
      agentSessionId: payload?.session_id,
    });

  try {
    const built = buildCommandHookEnsureCapture(payload, agentType, env, now);
    if (!built) return false;

    const claim = { ...built, cwd: built.cwd ?? cwd };
    if (detach) {
      return launchAgentSessionCaptureWake(claim, spawn, env, {
        ...launcherOptions,
        onFailure: reportFailure,
      });
    }
    return ensureAgentSessionCapture(claim, spawn, env);
  } catch (error) {
    reportFailure(error);
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
  main();
}
