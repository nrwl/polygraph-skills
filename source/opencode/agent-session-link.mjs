import {
  isPolygraphMcpToolName,
  linkAgentSession,
  logHookFailure,
} from '../hooks/agent-session-link.mjs';

export { logHookFailure } from '../hooks/agent-session-link.mjs';

function sessionRecord(result) {
  if (result?.error) {
    throw new Error(`OpenCode session lookup failed: ${JSON.stringify(result.error)}`);
  }
  const record =
    result && typeof result === 'object' && Object.hasOwn(result, 'data')
      ? result.data
      : result;
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record
    : undefined;
}

export async function resolveOpenCodeRootSessionId(client, sessionId) {
  if (!sessionId) return undefined;
  if (typeof client?.session?.get !== 'function') {
    throw new Error('OpenCode client.session.get is unavailable');
  }

  const seen = new Set();
  let current = sessionId;
  while (current) {
    if (seen.has(current)) {
      throw new Error(`OpenCode session parent cycle detected at ${current}`);
    }
    seen.add(current);

    const record = sessionRecord(
      await client.session.get({ path: { id: current } })
    );
    if (!record) {
      throw new Error(`OpenCode session ${current} was not found`);
    }
    if (record.id !== current) {
      throw new Error(`OpenCode session lookup returned ${String(record.id)} for ${current}`);
    }

    if (!record.parentID) return current;
    if (typeof record.parentID !== 'string') {
      throw new Error(`OpenCode session ${current} has an invalid parentID`);
    }
    current = record.parentID;
  }

  return undefined;
}

export function createOpenCodeSessionLinker({
  client,
  directory,
  env = process.env,
  pid = process.pid,
  link,
  spawn,
} = {}) {
  const roots = new Map();
  const submitLink = link ?? ((claim) => linkAgentSession(claim, spawn, env));

  async function rootSessionId(sessionId) {
    if (!sessionId) return undefined;
    if (roots.has(sessionId)) return roots.get(sessionId);

    const root = await resolveOpenCodeRootSessionId(client, sessionId);
    if (root) roots.set(sessionId, root);
    return root;
  }

  async function submit(openCodeSessionId, cwd, polygraphSessionId) {
    if (!openCodeSessionId || env.POLYGRAPH_CHILD_AGENT) {
      return false;
    }

    const agentSessionId = await rootSessionId(openCodeSessionId);
    if (!agentSessionId) return false;

    return submitLink({
      ...(polygraphSessionId ? { polygraphSessionId } : {}),
      agentType: 'opencode',
      agentSessionId,
      cwd: cwd || directory || process.cwd(),
      pid,
      source: 'hook',
    });
  }

  return {
    async fromEnvironment(sessionId, cwd) {
      if (!env.POLYGRAPH_SESSION_ID) return false;
      return submit(sessionId, cwd, env.POLYGRAPH_SESSION_ID);
    },

    async fromToolActivity(input) {
      if (!isPolygraphMcpToolName(input?.tool)) return false;
      return submit(input?.sessionID);
    },
  };
}
