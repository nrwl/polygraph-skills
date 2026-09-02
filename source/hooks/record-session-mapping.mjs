import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookLink,
  commandHookHarnessPid,
  hookPayloadSessionId,
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
  logFailure = logHookFailure,
} = {}) {
  try {
    const link = buildCommandHookLink(payload, agentType, env);
    if (!link) return false;

    const claim = {
      ...link,
      cwd: link.cwd ?? process.cwd(),
    };
    const harnessPid = commandHookHarnessPid(agentType, payload, pid);
    if (harnessPid !== undefined) claim.pid = harnessPid;

    return linkAgentSession(claim, spawn, env);
  } catch (error) {
    logFailure(`${agentType || 'unknown'}:link-agent-session`, error, {
      hookEventName: payload?.hook_event_name,
      agentSessionId: hookPayloadSessionId(payload),
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
