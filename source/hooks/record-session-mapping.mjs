import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookClaim,
  linkAgentSession,
  logHookFailure,
} from './agent-session-link.mjs';

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
  pid = process.ppid,
  spawn,
} = {}) {
  try {
    const claim = buildCommandHookClaim(payload, agentType, env);
    if (!claim) return false;

    return linkAgentSession(
      {
        ...claim,
        pid,
        cwd: claim.cwd ?? process.cwd(),
      },
      spawn
    );
  } catch (error) {
    logHookFailure(`${agentType || 'unknown'}:link-agent-session`, error, {
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
