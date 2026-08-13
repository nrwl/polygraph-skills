import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookFinalize,
  finalizeAgentSession,
} from './agent-session-finalize.mjs';
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
} = {}) {
  try {
    const finalize = buildCommandHookFinalize(payload, agentType, env);
    if (!finalize) return false;
    return finalizeAgentSession(
      {
        ...finalize,
        cwd: finalize.cwd ?? process.cwd(),
      },
      spawn,
      env
    );
  } catch (error) {
    logHookFailure(`${agentType || 'unknown'}:finalize-agent-session`, error, {
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
