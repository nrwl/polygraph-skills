import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_LOG_MAX_BYTES = 5 * 1024 * 1024;

export const SESSION_MUTATION_TOOLS = Object.freeze([
  'add_repo',
  'allow_agent',
  'archive_session',
  'associate_pr',
  'create_pr',
  'deny_agent',
  'git_fetch',
  'link_reference',
  'mark_pr_ready',
  'pack_and_copy',
  'push_branch',
  'spawn_agent',
  'start_session',
  'stop_agent',
  'update_session',
  'upload_artifact',
]);

const SESSION_MUTATION_TOOL_SET = new Set(SESSION_MUTATION_TOOLS);
const AGENT_TYPES = new Set(['claude', 'codex', 'opencode']);
const COMMAND_HOOK_PREFIXES = [
  'mcp__polygraph-mcp__',
  'mcp__polygraph_mcp__',
  'mcp__plugin_polygraph_polygraph-mcp__',
  'mcp__plugin_polygraph_polygraph_mcp__',
];
const OPENCODE_PREFIXES = [
  'polygraph-mcp_',
  'polygraph_mcp_',
  'polygraph_',
];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parsePolygraphMutationTool(toolName) {
  const name = nonEmptyString(toolName);
  if (!name) return undefined;

  for (const prefix of [...COMMAND_HOOK_PREFIXES, ...OPENCODE_PREFIXES]) {
    if (!name.startsWith(prefix)) continue;
    const operation = name.slice(prefix.length);
    return SESSION_MUTATION_TOOL_SET.has(operation) ? operation : undefined;
  }

  return undefined;
}

function sessionIdFromRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return (
    nonEmptyString(value.sessionId) ??
    nonEmptyString(value.polygraphSessionId)
  );
}

function sessionIdFromText(text) {
  const value = nonEmptyString(text);
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value);
    const fromJson =
      sessionIdFromRecord(parsed) ??
      sessionIdFromRecord(parsed?.data) ??
      sessionIdFromRecord(parsed?.result);
    if (fromJson) return fromJson;
  } catch {
    // Successful MCP responses are often plain text rather than JSON.
  }

  return value.match(/^Session\s+([^\s(]+)/m)?.[1];
}

export function extractStartedSessionId(toolResponse) {
  if (typeof toolResponse === 'string') {
    return sessionIdFromText(toolResponse);
  }
  if (!toolResponse || typeof toolResponse !== 'object') {
    return undefined;
  }
  if (toolResponse.isError === true) {
    return undefined;
  }

  const direct =
    sessionIdFromRecord(toolResponse) ??
    sessionIdFromRecord(toolResponse.structuredContent) ??
    sessionIdFromRecord(toolResponse.data) ??
    sessionIdFromRecord(toolResponse.result);
  if (direct) return direct;

  const output = sessionIdFromText(toolResponse.output);
  if (output) return output;

  if (Array.isArray(toolResponse.content)) {
    for (const block of toolResponse.content) {
      const fromBlock = sessionIdFromRecord(block) ?? sessionIdFromText(block?.text);
      if (fromBlock) return fromBlock;
    }
  }

  return undefined;
}

export function derivePolygraphSessionClaim({
  toolName,
  toolInput,
  toolResponse,
} = {}) {
  const operation = parsePolygraphMutationTool(toolName);
  if (!operation) return undefined;
  if (toolResponse?.isError === true) return undefined;

  const polygraphSessionId =
    operation === 'start_session'
      ? extractStartedSessionId(toolResponse)
      : nonEmptyString(toolInput?.sessionId);
  if (!polygraphSessionId) return undefined;

  return {
    operation,
    polygraphSessionId,
    ...(operation === 'start_session' ? { setResumeTarget: true } : {}),
  };
}

export function buildLinkAgentSessionArgs({
  polygraphSessionId,
  agentType,
  agentSessionId,
  cwd,
  transcriptPath,
  pid,
  setResumeTarget,
  source,
}) {
  const session = nonEmptyString(polygraphSessionId);
  const harnessSession = nonEmptyString(agentSessionId);
  const claimSource = nonEmptyString(source);
  if (!session) throw new Error('polygraphSessionId is required');
  if (!AGENT_TYPES.has(agentType)) throw new Error(`Unsupported agent type: ${agentType}`);
  if (!harnessSession) throw new Error('agentSessionId is required');
  if (!claimSource) throw new Error('source is required');

  const args = [
    '_link-agent-session',
    '--session',
    session,
    '--agent-type',
    agentType,
    '--agent-session-id',
    harnessSession,
  ];

  const workingDirectory = nonEmptyString(cwd);
  if (workingDirectory) args.push('--cwd', workingDirectory);

  const transcript = nonEmptyString(transcriptPath);
  if (transcript) args.push('--transcript-path', transcript);

  if (Number.isSafeInteger(pid) && pid > 0) {
    args.push('--pid', String(pid));
  }

  if (setResumeTarget === true) {
    args.push('--set-resume-target');
  }

  args.push('--source', claimSource);
  return args;
}

export function linkAgentSession(claim, spawn = spawnSync) {
  const args = buildLinkAgentSessionArgs(claim);
  const result = spawn('polygraph', args, {
    encoding: 'utf8',
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

export function buildCommandHookClaim(payload, agentType, env = process.env) {
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
    const derived = derivePolygraphSessionClaim({
      toolName: payload.tool_name,
      toolInput: payload.tool_input,
      toolResponse: payload.tool_response,
    });
    return derived
      ? {
          ...common,
          polygraphSessionId: derived.polygraphSessionId,
          ...(derived.setResumeTarget ? { setResumeTarget: true } : {}),
        }
      : undefined;
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
