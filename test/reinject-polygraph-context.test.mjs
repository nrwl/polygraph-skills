import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  findSidecar,
  buildPolygraphContext,
} from '../source/hooks/reinject-polygraph-context.mjs';

const CLAUDE_ID = '88b2ff2e-b146-458c-85fc-109c7bc12f26';
const POLY_ID = 'chipped-twig-23a03-3dba703b';

// Build a fake ~/.polygraph root with one session and its parent sidecar.
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-root-'));

  const sidecarDir = path.join(root, 'sidecars', POLY_ID);
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    path.join(sidecarDir, `parent-${CLAUDE_ID}.json`),
    JSON.stringify({
      sessionId: POLY_ID,
      parentSessionId: CLAUDE_ID,
      parentAgentType: 'claude',
    })
  );

  const sessionDir = path.join(root, 'sessions', POLY_ID, 'session');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    path.join(sessionDir, 'session.json'),
    JSON.stringify({
      sessionId: POLY_ID,
      orgId: 'org-123',
      agentType: 'claude',
      repos: [
        {
          repoFullName: 'nrwl/polygraph-skills',
          isInitiator: true,
          materialization: { strategy: 'in-place' },
        },
        {
          repoFullName: 'nrwl/ocean',
          isInitiator: false,
          materialization: { strategy: 'clone' },
        },
      ],
    })
  );

  writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ selectedUrl: 'https://example.test' })
  );

  return root;
}

test('findSidecar resolves the Polygraph session id from a Claude session id', () => {
  const root = makeRoot();
  try {
    const sidecar = findSidecar(CLAUDE_ID, root);
    assert.ok(sidecar);
    assert.equal(sidecar.sessionId, POLY_ID);
    assert.equal(sidecar.parentAgentType, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findSidecar returns null for an unknown Claude session id', () => {
  const root = makeRoot();
  try {
    assert.equal(findSidecar('does-not-exist', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findSidecar returns null when there is no sidecars directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-empty-'));
  try {
    assert.equal(findSidecar(CLAUDE_ID, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildPolygraphContext includes session id, URL, and repo list', () => {
  const root = makeRoot();
  try {
    const ctx = buildPolygraphContext(CLAUDE_ID, root);
    assert.ok(ctx);
    assert.match(ctx, /Polygraph session id: chipped-twig-23a03-3dba703b/);
    assert.match(
      ctx,
      /Session URL: https:\/\/example\.test\/orgs\/org-123\/sessions\/chipped-twig-23a03-3dba703b/
    );
    assert.match(ctx, /This Claude session id \(parent agent\): 88b2ff2e-/);
    assert.match(ctx, /- nrwl\/polygraph-skills \(initiator\) \[in-place\]/);
    assert.match(ctx, /- nrwl\/ocean \[clone\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildPolygraphContext returns null outside a Polygraph session', () => {
  const root = makeRoot();
  try {
    assert.equal(buildPolygraphContext('not-a-session', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildPolygraphContext omits the URL when org or base URL is missing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-nourl-'));
  try {
    const sidecarDir = path.join(root, 'sidecars', POLY_ID);
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(
      path.join(sidecarDir, `parent-${CLAUDE_ID}.json`),
      JSON.stringify({ sessionId: POLY_ID })
    );
    const sessionDir = path.join(root, 'sessions', POLY_ID, 'session');
    mkdirSync(sessionDir, { recursive: true });
    // No orgId, no config.json -> no URL line.
    writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ sessionId: POLY_ID, repos: [] })
    );

    const ctx = buildPolygraphContext(CLAUDE_ID, root);
    assert.ok(ctx);
    assert.doesNotMatch(ctx, /Session URL:/);
    assert.match(ctx, /Repositories in this session: \(none recorded\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
