// SessionStart hook: when the calling agent (Claude Code or Codex) is running
// inside a Polygraph session, re-inject the Polygraph session id and basic
// session info as context. This restores facts that context compaction may
// have dropped, and re-establishes them on resume.
//
// Shared by the Claude and Codex plugins — both fire a SessionStart hook whose
// stdin carries `session_id` and whose stdout `additionalContext` is injected
// into the model.
//
// Everything is read from local Polygraph state — no network calls:
//   ~/.polygraph/sidecars/<polygraphSessionId>/parent-<agentSessionId>.json
//       maps this agent session id -> Polygraph session id (the "parent log
//       sidecar" the CLI uses to stream parent-agent activity to the UI).
//   ~/.polygraph/sessions/<polygraphSessionId>/session/session.json
//       holds the session's repos, agentType, and orgId.
//   ~/.polygraph/config.json
//       holds selectedUrl, used to build the session URL.
//
// Outside a Polygraph session (no matching sidecar) the hook is a silent no-op.

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function polygraphRoot(home = homedir()) {
  return path.join(home, '.polygraph');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Find the sidecar that maps an agent session id to a Polygraph session.
// Returns the parsed sidecar object, or null when none matches.
export function findSidecar(agentSessionId, root = polygraphRoot()) {
  if (!agentSessionId) return null;

  const sidecarsDir = path.join(root, 'sidecars');
  if (!existsSync(sidecarsDir)) return null;

  const fileName = `parent-${agentSessionId}.json`;
  let entries;
  try {
    entries = readdirSync(sidecarsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sidecarsDir, entry.name, fileName);
    if (existsSync(candidate)) {
      return readJson(candidate);
    }
  }
  return null;
}

// Build the context block for a Polygraph session, or null when the agent is
// not running inside a Polygraph session.
export function buildPolygraphContext(agentSessionId, root = polygraphRoot()) {
  const sidecar = findSidecar(agentSessionId, root);
  if (!sidecar || !sidecar.sessionId) return null;

  const polygraphSessionId = sidecar.sessionId;
  const agentType = sidecar.parentAgentType || 'agent';
  const session =
    readJson(
      path.join(root, 'sessions', polygraphSessionId, 'session', 'session.json')
    ) ?? {};
  const config = readJson(path.join(root, 'config.json')) ?? {};

  const baseUrl = config.selectedUrl;
  const orgId = session.orgId;
  const sessionUrl =
    baseUrl && orgId
      ? `${baseUrl}/orgs/${orgId}/sessions/${polygraphSessionId}`
      : null;

  const repos = Array.isArray(session.repos) ? session.repos : [];
  const repoLines = repos.map((repo) => {
    const role = repo.isInitiator ? ' (initiator)' : '';
    const strategy = repo.materialization?.strategy
      ? ` [${repo.materialization.strategy}]`
      : '';
    return `  - ${repo.repoFullName}${role}${strategy}`;
  });

  const lines = [
    'You are running inside a Polygraph session. Keep this in mind across compaction:',
    `- Polygraph session id: ${polygraphSessionId}`,
    sessionUrl ? `- Session URL: ${sessionUrl}` : null,
    `- Parent agent (${agentType}) session id: ${agentSessionId}`,
    repoLines.length
      ? ['- Repositories in this session:', ...repoLines].join('\n')
      : '- Repositories in this session: (none recorded)',
    '- To act in this session (delegating work, monitoring CI, opening PRs, etc.), load the polygraph skill for guidance.',
  ].filter((line) => line != null);

  return lines.join('\n');
}

function readStdin() {
  try {
    // fd 0 — Claude Code / Codex pipe the hook payload as JSON on stdin.
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function main() {
  let payload = {};
  const raw = readStdin();
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  const agentSessionId =
    payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';

  const context = buildPolygraphContext(agentSessionId);
  if (!context) return; // not a Polygraph session — stay silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  );
}

// Run only when executed directly as a hook, not when imported (e.g. by tests).
// realpath both sides so the check holds when the plugin lives under a symlinked
// path (e.g. macOS /tmp -> /private/tmp, or a symlinked plugin install dir),
// where import.meta.url is realpath'd by Node but process.argv[1] is not.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
