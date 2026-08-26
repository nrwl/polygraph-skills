import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const AGENT_TYPES = new Set(['claude', 'codex', 'opencode', 'cursor']);
const COMMAND_HOOK_TOOL = /^mcp__(?:plugin_polygraph_)?polygraph[-_]mcp__/;
const OPENCODE_TOOL = /^polygraph(?:(?:-|_)mcp)?_/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isManagedChildEnvironment(env) {
  return Boolean(env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT'));
}

export function isPolygraphMcpToolName(toolName) {
  const name = nonEmptyString(toolName);
  return Boolean(name && (COMMAND_HOOK_TOOL.test(name) || OPENCODE_TOOL.test(name)));
}

export function buildLinkAgentSessionArgs({
  polygraphSessionId,
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
  pid,
  source,
}) {
  const session = nonEmptyString(polygraphSessionId);
  const harnessSession = nonEmptyString(agentSessionId);
  const claimSource = nonEmptyString(source);
  if (!AGENT_TYPES.has(agentType)) throw new Error(`Unsupported agent type: ${agentType}`);
  if (!harnessSession) throw new Error('agentSessionId is required');
  if (!claimSource) throw new Error('source is required');

  const args = ['_link-agent-session'];
  if (session) args.push('--session', session);
  args.push('--agent-type', agentType, '--agent-session-id', harnessSession);

  const workingDirectory = nonEmptyString(cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  if (Number.isSafeInteger(pid) && pid > 0) {
    args.push('--pid', String(pid));
  }

  args.push('--source', claimSource);
  return args;
}

/**
 * Node runtime for the JS-entry fallback. This shim also runs inside
 * non-Node hosts (the opencode plugin executes it in-process, and opencode
 * is a compiled Bun binary), where process.execPath is not a Node
 * executable — fall back to PATH resolution there.
 */
function nodeRuntime() {
  const base = basename(process.execPath).toLowerCase();
  return base === 'node' || base === 'node.exe' ? process.execPath : 'node';
}

export function linkAgentSession(claim, spawn = spawnSync, env = process.env) {
  if (isManagedChildEnvironment(env)) return false;

  const args = buildLinkAgentSessionArgs(claim);
  const command = nonEmptyString(env?.POLYGRAPH_CLI) ?? 'polygraph';
  const commandEnv = nonEmptyString(claim.polygraphSessionId) ? env : { ...env };
  if (commandEnv !== env) {
    delete commandEnv.POLYGRAPH_SESSION_ID;
    delete commandEnv.POLYGRAPH_CAPTURE_TOKEN;
  }

  const spawnOptions = {
    encoding: 'utf8',
    env: commandEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  };

  let result = spawn(command, args, spawnOptions);

  // POLYGRAPH_CLI may point at a plain JS entry that cannot be spawned
  // directly: a dev build without the executable bit, or a platform that
  // cannot exec scripts. A spawn that failed to LAUNCH ran nothing, so the
  // retry under a Node runtime is side-effect free — and anything that
  // spawns directly today keeps its exact behavior.
  if (result?.error && /\.[cm]?js$/i.test(command)) {
    result = spawn(nodeRuntime(), [command, ...args], spawnOptions);
  }

  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = nonEmptyString(result?.stderr);
    throw new Error(
      `polygraph _link-agent-session exited with status ${String(result?.status)}` +
        (detail ? `: ${detail}` : '')
    );
  }

  return true;
}

export function buildCommandHookLink(payload, agentType, env = process.env) {
  if (!payload || typeof payload !== 'object') return undefined;
  if (isManagedChildEnvironment(env)) return undefined;

  // Cursor payloads carry the id in both session_id and conversation_id;
  // the fallback keeps the link working if one of them disappears.
  const agentSessionId =
    nonEmptyString(payload.session_id) ?? nonEmptyString(payload.conversation_id);
  if (!agentSessionId) return undefined;

  // Cursor has no top-level cwd; workspace_roots[0] is the launch directory.
  const workspaceRoot = Array.isArray(payload.workspace_roots)
    ? nonEmptyString(payload.workspace_roots[0])
    : undefined;

  const common = {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd) ?? workspaceRoot,
    transcriptPath: nonEmptyString(payload.transcript_path),
    source: 'hook',
  };

  // Claude and Codex send PascalCase event names; cursor sends camelCase.
  if (
    payload.hook_event_name === 'SessionStart' ||
    payload.hook_event_name === 'sessionStart'
  ) {
    const polygraphSessionId = nonEmptyString(env.POLYGRAPH_SESSION_ID);
    if (polygraphSessionId) return { ...common, polygraphSessionId };

    // Ordinary sessions of every supported harness are eligible for
    // speculative capture, so later session searches can find them even when
    // the session was not launched with Polygraph session evidence.
    return AGENT_TYPES.has(agentType) ? common : undefined;
  }

  if (payload.hook_event_name === 'PostToolUse') {
    return isPolygraphMcpToolName(payload.tool_name) ? common : undefined;
  }

  return undefined;
}

export function logHookFailure(
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
      // There may be no prior log, and logging must stay best-effort.
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
    // Hook diagnostics must never break the harness event that triggered them.
  }
}
