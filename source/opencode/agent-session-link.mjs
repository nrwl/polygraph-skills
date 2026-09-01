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

export async function linkOpenCodeSessionCreatedEvent(input, sessionLinker) {
  const event = input?.event;
  if (event?.type !== 'session.created') return false;

  return sessionLinker.fromSessionCreated(event.properties?.info);
}

export function deferOpenCodeToolActivity(
  input,
  sessionLinker,
  onError,
  schedule = setTimeout
) {
  schedule(() => {
    return Promise.resolve()
      .then(() => sessionLinker.fromToolActivity(input))
      .catch((error) => {
        try {
          return onError(error);
        } catch {
          // Deferred proof reads are best-effort and cannot reject the host hook.
        }
      })
      .catch(() => {});
  }, 0);
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
  const linkedLifecycleSessions = new Set();
  const submitLink = link ?? ((claim) => linkAgentSession(claim, spawn, env));

  async function rootSessionId(sessionId) {
    if (!sessionId) return undefined;
    if (roots.has(sessionId)) return roots.get(sessionId);

    const root = await resolveOpenCodeRootSessionId(client, sessionId);
    if (root) roots.set(sessionId, root);
    return root;
  }

  async function submit(openCodeSessionId, cwd, polygraphSessionId, lifecycle = false) {
    if (
      !openCodeSessionId ||
      (env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT'))
    ) {
      return false;
    }

    const agentSessionId = await rootSessionId(openCodeSessionId);
    if (!agentSessionId) return false;

    const lifecycleKey = polygraphSessionId
      ? `${polygraphSessionId}\0${agentSessionId}`
      : lifecycle
        ? `\0${agentSessionId}`
        : undefined;
    if (lifecycleKey && linkedLifecycleSessions.has(lifecycleKey)) return false;

    const linked = await submitLink({
      ...(polygraphSessionId ? { polygraphSessionId } : {}),
      agentType: 'opencode',
      agentSessionId,
      cwd: cwd || directory || process.cwd(),
      pid,
      source: 'hook',
    });
    if (linked && lifecycleKey) linkedLifecycleSessions.add(lifecycleKey);
    return linked;
  }

  async function fromEnvironment(sessionId, cwd) {
    if (!env.POLYGRAPH_SESSION_ID) return false;
    return submit(sessionId, cwd, env.POLYGRAPH_SESSION_ID);
  }

  return {
    async fromSessionCreated(info) {
      if (!info?.id || info.parentID) return false;
      roots.set(info.id, info.id);
      if (env.POLYGRAPH_SESSION_ID) {
        return fromEnvironment(info.id, info.directory);
      }
      // Ordinary OpenCode sessions are eligible for speculative capture, so
      // later session searches can find them even when the session was not
      // launched with Polygraph session evidence.
      return submit(info.id, info.directory, undefined, true);
    },

    fromEnvironment,

    async fromToolActivity(input) {
      if (!isPolygraphMcpToolName(input?.tool)) return false;
      return submit(input?.sessionID);
    },
  };
}
