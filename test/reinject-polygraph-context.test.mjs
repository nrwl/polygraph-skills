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

// These tests exercise the default sessions root (<root>/sessions); make sure
// an ambient POLYGRAPH_ROOT cannot redirect it.
delete process.env.POLYGRAPH_ROOT;

// Directory holding the parent sidecar for the given layout.
function sidecarDirFor(root, location) {
  return location === 'legacy'
    ? path.join(root, 'sidecars', POLY_ID) // legacy: <root>/sidecars/<sessionId>/
    : path.join(root, 'sessions', POLY_ID, 'sidecars'); // new: <root>/sessions/<sessionId>/sidecars/
}

function writeParentSidecar(root, location, extra = {}) {
  const sidecarDir = sidecarDirFor(root, location);
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    path.join(sidecarDir, `parent-${CLAUDE_ID}.json`),
    JSON.stringify({
      sessionId: POLY_ID,
      parentSessionId: CLAUDE_ID,
      parentAgentType: 'claude',
      ...extra,
    })
  );
}

// Build a fake ~/.polygraph root with one session and its parent sidecar.
function makeRoot(location = 'new') {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-root-'));

  writeParentSidecar(root, location);

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

test('findSidecar resolves the session id from the NEW per-session sidecars dir', () => {
  const root = makeRoot('new');
  try {
    const sidecar = findSidecar(CLAUDE_ID, root);
    assert.ok(sidecar);
    assert.equal(sidecar.sessionId, POLY_ID);
    assert.equal(sidecar.parentAgentType, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findSidecar falls back to the LEGACY sidecars dir', () => {
  const root = makeRoot('legacy');
  try {
    const sidecar = findSidecar(CLAUDE_ID, root);
    assert.ok(sidecar);
    assert.equal(sidecar.sessionId, POLY_ID);
    assert.equal(sidecar.parentAgentType, 'claude');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findSidecar prefers the new location when the sidecar exists in both', () => {
  const root = makeRoot('new');
  try {
    writeParentSidecar(root, 'new', { marker: 'new-location' });
    writeParentSidecar(root, 'legacy', { marker: 'legacy-location' });

    const sidecar = findSidecar(CLAUDE_ID, root);
    assert.ok(sidecar);
    assert.equal(sidecar.marker, 'new-location');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findSidecar honours POLYGRAPH_ROOT as the sessions root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pg-envroot-'));
  const customRoot = mkdtempSync(path.join(tmpdir(), 'pg-envroot-custom-'));
  const saved = process.env.POLYGRAPH_ROOT;
  try {
    const sidecarDir = path.join(customRoot, POLY_ID, 'sidecars');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(
      path.join(sidecarDir, `parent-${CLAUDE_ID}.json`),
      JSON.stringify({ sessionId: POLY_ID, parentAgentType: 'claude' })
    );

    process.env.POLYGRAPH_ROOT = customRoot;
    const sidecar = findSidecar(CLAUDE_ID, root);
    assert.ok(sidecar);
    assert.equal(sidecar.sessionId, POLY_ID);
  } finally {
    if (saved === undefined) delete process.env.POLYGRAPH_ROOT;
    else process.env.POLYGRAPH_ROOT = saved;
    rmSync(root, { recursive: true, force: true });
    rmSync(customRoot, { recursive: true, force: true });
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

test('findSidecar returns null when neither sidecars location exists', () => {
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
    assert.match(ctx, /Parent agent \(claude\) session id: 88b2ff2e-/);
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
