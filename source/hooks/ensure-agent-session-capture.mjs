import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookEnsureCapture,
  ensureAgentSessionCapture,
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
  env = process.env,
  spawn,
  logFailure = logHookFailure,
  cwd = process.cwd(),
} = {}) {
  try {
    const claim = buildCommandHookEnsureCapture(payload, agentType, env);
    if (!claim) return false;
    return ensureAgentSessionCapture(
      {
        ...claim,
        cwd: claim.cwd ?? cwd,
      },
      spawn,
      env
    );
  } catch (error) {
    logFailure(`${agentType || 'unknown'}:ensure-agent-session-capture`, error, {
      hookEventName: payload?.hook_event_name,
      agentSessionId: payload?.session_id,
    });
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
