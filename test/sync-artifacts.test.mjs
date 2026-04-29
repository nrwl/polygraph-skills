import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderArtifact, rootDir } from '../scripts/src/sync-artifacts/common.mjs';
import { buildMcpConfig } from '../scripts/src/sync-artifacts/package-artifacts.mjs';

test('renderArtifact preserves a valid frontmatter boundary for the codex polygraph skill', () => {
  const raw = readFileSync(join(rootDir, 'source', 'skills', 'polygraph', 'SKILL.md'), 'utf8');
  const rendered = renderArtifact(raw, 'codex');

  assert.match(rendered, /^---\n[\s\S]*?\n---\n/);
  assert.doesNotMatch(rendered, /\n---#/);
  assert.match(rendered, /\n# Multi-Repo Coordination with Polygraph\b/);
});

test('rendered polygraph skill documents session linking', () => {
  const raw = readFileSync(join(rootDir, 'source', 'skills', 'polygraph', 'SKILL.md'), 'utf8');
  const rendered = renderArtifact(raw, 'codex');

  assert.match(rendered, /link_session/);
  assert.match(rendered, /polygraph session link --targetSessionId=SESSION_ID --linkedSessionId=SESSION_ID/);
  assert.match(rendered, /polygraph session show --details <session-id>/);
  assert.match(rendered, /session\.linkedSessions/);
  assert.match(rendered, /targetSessionId: "<current-session-id>"/);
  assert.match(rendered, /linkedSessionId: "<inspected-session-id>"/);
  assert.doesNotMatch(rendered, /--(?:target|dependency|dependent)Id\b|\b(?:target|dependency|dependent)Id:/);
});

test('buildMcpConfig wraps MCP servers under mcpServers', () => {
  assert.deepEqual(buildMcpConfig(), {
    mcpServers: {
      'polygraph-mcp': {
        type: 'stdio',
        command: 'npx',
        args: ['polygraph-mcp@latest'],
      },
    },
  });
});
