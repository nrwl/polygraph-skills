import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderArtifact, rootDir } from '../scripts/src/sync-artifacts/common.mjs';

test('renderArtifact preserves a valid frontmatter boundary for the codex polygraph skill', () => {
  const raw = readFileSync(join(rootDir, 'source', 'skills', 'polygraph', 'SKILL.md'), 'utf8');
  const rendered = renderArtifact(raw, 'codex');

  assert.match(rendered, /^---\n[\s\S]*?\n---\n/);
  assert.doesNotMatch(rendered, /\n---#/);
  assert.match(rendered, /\n# Multi-Repo Coordination with Polygraph\b/);
});
