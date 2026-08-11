import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

const AGENT_TYPES = new Set(['claude', 'codex', 'opencode']);
const COMMAND_HOOK_TOOL = /^mcp__(?:plugin_polygraph_)?polygraph[-_]mcp__/;
const OPENCODE_TOOL = /^polygraph(?:(?:-|_)mcp)?_/;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
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

export function linkAgentSession(claim, spawn = spawnSync, env = process.env) {
  const args = buildLinkAgentSessionArgs(claim);
  const commandEnv = nonEmptyString(claim.polygraphSessionId) ? env : { ...env };
  if (commandEnv !== env) delete commandEnv.POLYGRAPH_SESSION_ID;

  const result = spawn('polygraph', args, {
    encoding: 'utf8',
    env: commandEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });

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
  if (env.POLYGRAPH_CHILD_AGENT) return undefined;

  const agentSessionId = nonEmptyString(payload.session_id);
  if (!agentSessionId) return undefined;

  const common = {
    agentType,
    agentSessionId,
    cwd: nonEmptyString(payload.cwd),
    transcriptPath: nonEmptyString(payload.transcript_path),
    source: 'hook',
  };

  if (payload.hook_event_name === 'SessionStart') {
    const polygraphSessionId = nonEmptyString(env.POLYGRAPH_SESSION_ID);
    return polygraphSessionId ? { ...common, polygraphSessionId } : undefined;
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
