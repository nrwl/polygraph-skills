import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildCommandHookLink,
  hookPayloadSessionId,
  linkAgentSession,
  logHookFailure,
} from './agent-session-link.mjs';
import { fallbackClaimDirectory } from './capture-cli.mjs';

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
} = {}) {
  try {
    const link = buildCommandHookLink(payload, agentType, env);
    if (!link) return false;

    // Claude and Codex run this hook in the session directory, so the hook's
    // own cwd stands in when the payload carries none; Cursor's hook cwd is
    // the plugin root and is never recorded. Read lazily, inside the
    // protected path, because a deleted cwd makes process.cwd() throw.
    return linkAgentSession(
      {
        ...link,
        cwd: link.cwd ?? fallbackClaimDirectory(agentType),
      },
      spawn,
      env
    );
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
