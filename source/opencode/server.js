// ⚠️  IMPORTANT — READ BEFORE EDITING OR ADDING CODE TO THIS FILE ⚠️
//
// OpenCode loads this file directly as a plugin module. Any `export` beyond
// the plugin entry (`PolygraphPlugin` / `export default`) breaks OpenCode
// plugin loading ENTIRELY for every user who has the plugin installed.
//
// DO NOT add new exports to this file. Put shared or testable logic in sibling
// modules under source/opencode/ (e.g. agent-session-link.mjs) and import
// it here instead.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  createOpenCodeSessionLinker,
  logHookFailure,
} from './agent-session-link.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = __dirname;
const skillsDir = path.join(packageRoot, 'skills');
const agentsDir = path.join(packageRoot, 'agents');

export const PolygraphPlugin = async ({ client, directory } = {}) => {
  const agents = loadAgents();
  const sessionLinker = createOpenCodeSessionLinker({ client, directory });

  return {
    config: async (cfg) => {
      cfg.skills ??= {};
      cfg.skills.paths ??= [];
      if (!cfg.skills.paths.includes(skillsDir)) {
        cfg.skills.paths.push(skillsDir);
      }

      cfg.agent ??= {};
      for (const [name, agent] of Object.entries(agents)) {
        cfg.agent[name] = agent;
      }
    },

    'shell.env': async (input, output) => {
      try {
        output.env.POLYGRAPH_AGENT_SESSION_ID = input.sessionID;
        output.env.POLYGRAPH_AGENT_TYPE = 'opencode';
        await sessionLinker.fromEnvironment(input.sessionID, input.cwd);
      } catch (error) {
        // Never let a hook failure break the OpenCode session; just record it.
        logHookFailure('opencode:shell.env', error, { sessionID: input?.sessionID });
      }
    },

    'tool.execute.after': async (input) => {
      try {
        await sessionLinker.fromToolActivity(input);
      } catch (error) {
        logHookFailure('opencode:tool.execute.after', error, {
          sessionID: input?.sessionID,
          tool: input?.tool,
        });
      }
    },

    // OpenCode has no SessionStart hook, but the Polygraph CLI already seeds the
    // session id into context at launch. The one thing compaction can drop is
    // that identity, so we steer the summary prompt to retain it. This fires
    // before each compaction; the note is appended to the summarization prompt
    // (best-effort — we trust the model to keep the id + repos in the summary).
    'experimental.session.compacting': async (input, output) => {
      try {
        const note = polygraphCompactionNote(input.sessionID);
        if (note) {
          output.context.push(note);
        }
        await sessionLinker.fromEnvironment(input.sessionID);
      } catch (error) {
        // Never let a hook failure break the OpenCode session; just record it.
        logHookFailure('opencode:session.compacting', error, {
          sessionID: input?.sessionID,
        });
      }
    },
  };
};

export default PolygraphPlugin;

function loadAgents() {
  if (!existsSync(agentsDir)) {
    return {};
  }

  const result = {};
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const name = path.basename(entry.name, '.md');
    const raw = readFileSync(path.join(agentsDir, entry.name), 'utf8');
    const { data, content } = parseFrontmatter(raw);
    const description = stringValue(data.description);
    if (!description) {
      throw new Error(`OpenCode agent ${entry.name} must define a description`);
    }

    result[name] = {
      mode: stringValue(data.mode) || 'subagent',
      description,
      prompt: content.trim(),
      ...(stringValue(data.color) ? { color: stringValue(data.color) } : {}),
      ...(booleanValue(data.hidden) === undefined ? {} : { hidden: booleanValue(data.hidden) }),
      ...(numberValue(data.steps) === undefined ? {} : { steps: numberValue(data.steps) }),
      ...(recordValue(data.permission) ? { permission: recordValue(data.permission) } : {}),
    };
  }

  return result;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  return {
    data: recordValue(yaml.load(match[1])) ?? {},
    content: match[2],
  };
}

function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

// --- Polygraph session context (mirrors source/hooks/reinject-polygraph-context.mjs) ---
//
// Resolve the Polygraph session for this OpenCode session id from local state,
// then build a short instruction telling the summarizer to keep the Polygraph
// session id and repo list in the compaction summary. Returns null when this is
// not a Polygraph session (no matching parent-log sidecar) — a silent no-op.
//
// These helpers must NOT be exported: OpenCode calls every export of this
// module as a plugin factory, and a factory that doesn't return a hooks object
// crashes the server on startup ("Unexpected server error").

function polygraphCompactionNote(agentSessionId, root) {
  const session = readPolygraphSession(agentSessionId, root);
  if (!session) {
    return undefined;
  }

  const repos = session.repos
    .map((repo) => repo.repoFullName)
    .filter(Boolean)
    .join(', ');

  return (
    `This conversation is running inside Polygraph session ${session.sessionId}` +
    (repos ? ` (repos: ${repos})` : '') +
    '. Preserve the Polygraph session id and the repo list verbatim in the ' +
    'summary so they remain available after compaction.'
  );
}

// Scan the immediate subdirectories of `baseDir`; for each, `candidatePath`
// maps the subdirectory name to a candidate parent-sidecar file. Returns the
// sessionId of the first match, or undefined.
function scanForParentSidecar(baseDir, candidatePath) {
  if (!existsSync(baseDir)) {
    return undefined;
  }

  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = candidatePath(entry.name);
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, 'utf8')).sessionId;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function readPolygraphSession(
  agentSessionId,
  root = path.join(homedir(), '.polygraph')
) {
  if (!agentSessionId) {
    return undefined;
  }

  const fileName = `parent-${agentSessionId}.json`;

  // New layout: <sessionsRoot>/<sessionId>/sidecars/parent-<agentSessionId>.json
  // (sessionsRoot = $POLYGRAPH_ROOT or <root>/sessions), with a fallback to
  // the legacy shared sidecars directory for sessions created by older CLIs.
  const sessionsDir = process.env.POLYGRAPH_ROOT?.trim() || path.join(root, 'sessions');
  const legacyDir = path.join(root, 'sidecars');
  const polygraphSessionId =
    scanForParentSidecar(sessionsDir, (sessionId) =>
      path.join(sessionsDir, sessionId, 'sidecars', fileName)
    ) ??
    scanForParentSidecar(legacyDir, (sessionId) =>
      path.join(legacyDir, sessionId, fileName)
    );
  if (!polygraphSessionId) {
    return undefined;
  }

  let session = {};
  try {
    session = JSON.parse(
      readFileSync(
        path.join(root, 'sessions', polygraphSessionId, 'session', 'session.json'),
        'utf8'
      )
    );
  } catch {
    session = {};
  }

  return {
    sessionId: polygraphSessionId,
    repos: Array.isArray(session.repos) ? session.repos : [],
  };
}
