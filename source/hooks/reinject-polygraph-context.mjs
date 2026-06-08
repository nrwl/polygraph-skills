// SessionStart hook: when this Claude session is running inside a Polygraph
// session, re-inject the Polygraph session id and basic session info as
// context. This restores facts that context compaction may have dropped, and
// re-establishes them on resume.
//
// Everything is read from local Polygraph state — no network calls:
//   ~/.polygraph/sidecars/<polygraphSessionId>/parent-<claudeSessionId>.json
//       maps this Claude session id -> Polygraph session id (the "parent log
//       sidecar" the CLI uses to stream parent-agent activity to the UI).
//   ~/.polygraph/sessions/<polygraphSessionId>/session/session.json
//       holds the session's repos, agentType, and orgId.
//   ~/.polygraph/config.json
//       holds selectedUrl, used to build the session URL.
//
// Outside a Polygraph session (no matching sidecar) the hook is a silent no-op.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
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

// Find the sidecar that maps a Claude session id to a Polygraph session.
// Returns the parsed sidecar object, or null when none matches.
export function findSidecar(claudeSessionId, root = polygraphRoot()) {
  if (!claudeSessionId) return null;

  const sidecarsDir = path.join(root, 'sidecars');
  if (!existsSync(sidecarsDir)) return null;

  const fileName = `parent-${claudeSessionId}.json`;
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

// Build the context block for a Polygraph session, or null when this is not a
// Polygraph-managed Claude session.
export function buildPolygraphContext(claudeSessionId, root = polygraphRoot()) {
  const sidecar = findSidecar(claudeSessionId, root);
  if (!sidecar || !sidecar.sessionId) return null;

  const polygraphSessionId = sidecar.sessionId;
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
    `- This Claude session id (parent agent): ${claudeSessionId}`,
    repoLines.length
      ? ['- Repositories in this session:', ...repoLines].join('\n')
      : '- Repositories in this session: (none recorded)',
    '- To act in this session (delegating work, monitoring CI, opening PRs, etc.), load the polygraph skill for guidance.',
  ].filter((line) => line != null);

  return lines.join('\n');
}

function readStdin() {
  try {
    // fd 0 — Claude Code pipes the hook payload as JSON on stdin.
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

  const claudeSessionId =
    payload.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';

  const context = buildPolygraphContext(claudeSessionId);
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

// Run only when executed directly as a hook, not when imported by tests.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && path.resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  main();
}
