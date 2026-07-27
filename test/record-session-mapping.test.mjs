import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCaptureMapping } from '../source/hooks/record-session-mapping.mjs';

// These tests exercise the default sessions root (~/.polygraph/sessions under
// the injected home); make sure an ambient POLYGRAPH_ROOT cannot redirect it.
delete process.env.POLYGRAPH_ROOT;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'pg-mapping-'));
}

// The session folder for a session, under the default sessions root.
function sessionDir(home, polygraphSessionId) {
  return join(home, '.polygraph', 'sessions', polygraphSessionId);
}

// New mapping location: the sidecars dir inside the session folder.
function sessionSidecarDir(home, polygraphSessionId) {
  return join(sessionDir(home, polygraphSessionId), 'sidecars');
}

// Legacy flat location, used only when the session directory does not exist.
function legacyDir(home, polygraphSessionId) {
  return join(home, '.polygraph', 'sidecars', polygraphSessionId);
}

// Create the session directory so writes route to the session folder.
function makeSessionDir(home, polygraphSessionId) {
  mkdirSync(sessionDir(home, polygraphSessionId), { recursive: true });
}

function readMappingFilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('mapping-'));
}

function readMappingJsonIn(dir) {
  const files = readMappingFilesIn(dir);
  assert.equal(files.length, 1, `expected exactly one mapping file in ${dir}`);
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
}

// ---------------------------------------------------------------------------
// Location routing
// ---------------------------------------------------------------------------

test('writeCaptureMapping writes into the session sidecars dir when the session directory exists', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-xyz');

    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-abc-123',
        polygraphSessionId: 'poly-xyz',
        cwd: '/some/project',
      },
      home
    );

    const files = readMappingFilesIn(sessionSidecarDir(home, 'poly-xyz'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^mapping-claude-sess-abc-123\.json$/);

    // Nothing new lands under the legacy flat dir.
    assert.equal(existsSync(legacyDir(home, 'poly-xyz')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping falls back to the legacy flat dir only when the session directory does not exist', () => {
  const home = makeHome();
  try {
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-legacy',
        polygraphSessionId: 'poly-legacy',
        cwd: '/repo',
      },
      home
    );

    const files = readMappingFilesIn(legacyDir(home, 'poly-legacy'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^mapping-claude-sess-legacy\.json$/);
    assert.equal(existsSync(sessionDir(home, 'poly-legacy')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping honours POLYGRAPH_ROOT as the sessions root', () => {
  const home = makeHome();
  const customRoot = mkdtempSync(join(tmpdir(), 'pg-custom-root-'));
  const saved = process.env.POLYGRAPH_ROOT;
  try {
    process.env.POLYGRAPH_ROOT = customRoot;
    mkdirSync(join(customRoot, 'poly-envroot'), { recursive: true });

    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-envroot',
        polygraphSessionId: 'poly-envroot',
        cwd: '/repo',
      },
      home
    );

    const dir = join(customRoot, 'poly-envroot', 'sidecars');
    assert.equal(readMappingFilesIn(dir).length, 1, 'written under POLYGRAPH_ROOT');
    assert.equal(existsSync(legacyDir(home, 'poly-envroot')), false);
  } finally {
    if (saved === undefined) delete process.env.POLYGRAPH_ROOT;
    else process.env.POLYGRAPH_ROOT = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(customRoot, { recursive: true, force: true });
  }
});

test('writeCaptureMapping honours globalRoot from ~/.polygraph/config.json as the sessions root', () => {
  const home = makeHome();
  const customRoot = mkdtempSync(join(tmpdir(), 'pg-global-root-'));
  try {
    mkdirSync(join(home, '.polygraph'), { recursive: true });
    writeFileSync(
      join(home, '.polygraph', 'config.json'),
      JSON.stringify({ globalRoot: customRoot })
    );
    mkdirSync(join(customRoot, 'poly-globalroot'), { recursive: true });

    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-globalroot',
        polygraphSessionId: 'poly-globalroot',
        cwd: '/repo',
      },
      home
    );

    const dir = join(customRoot, 'poly-globalroot', 'sidecars');
    assert.equal(readMappingFilesIn(dir).length, 1, 'written under globalRoot');
    assert.equal(existsSync(legacyDir(home, 'poly-globalroot')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(customRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mapping contents
// ---------------------------------------------------------------------------

test('writeCaptureMapping writes all required fields with correct values', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-1');

    const before = Date.now();
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-claude-1',
        polygraphSessionId: 'poly-1',
        cwd: '/workspace/my-repo',
        transcriptPath: '/tmp/transcript.jsonl',
        pid: 12345,
      },
      home
    );
    const after = Date.now();

    const mapping = readMappingJsonIn(sessionSidecarDir(home, 'poly-1'));

    assert.equal(mapping.version, 1);
    assert.equal(mapping.polygraphSessionId, 'poly-1');
    assert.equal(mapping.agentType, 'claude');
    assert.equal(mapping.agentSessionId, 'sess-claude-1');
    assert.equal(mapping.cwd, '/workspace/my-repo');
    assert.equal(mapping.transcriptPath, '/tmp/transcript.jsonl');
    assert.equal(mapping.pid, 12345);
    assert.equal(mapping.source, 'hook');
    assert.ok(Number.isFinite(mapping.firstSeenAt), 'firstSeenAt is a finite number');
    assert.ok(Number.isFinite(mapping.lastSeenAt), 'lastSeenAt is a finite number');
    assert.ok(mapping.firstSeenAt >= before);
    assert.ok(mapping.lastSeenAt <= after);
    assert.equal(mapping.firstSeenAt, mapping.lastSeenAt, 'first write: equal timestamps');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping omits transcriptPath when not provided', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-2');
    writeCaptureMapping(
      {
        agentType: 'codex',
        agentSessionId: 'thread-codex-99',
        polygraphSessionId: 'poly-2',
        cwd: '/repo',
        // transcriptPath intentionally absent
      },
      home
    );

    const mapping = readMappingJsonIn(sessionSidecarDir(home, 'poly-2'));
    assert.equal(Object.hasOwn(mapping, 'transcriptPath'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping omits transcriptPath when explicitly null', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-null-tp');
    writeCaptureMapping(
      {
        agentType: 'codex',
        agentSessionId: 'sess-null-tp',
        polygraphSessionId: 'poly-null-tp',
        cwd: '/repo',
        transcriptPath: null,
      },
      home
    );

    const mapping = readMappingJsonIn(sessionSidecarDir(home, 'poly-null-tp'));
    assert.equal(Object.hasOwn(mapping, 'transcriptPath'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping omits pid when not provided', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-3');
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-no-pid',
        polygraphSessionId: 'poly-3',
        cwd: '/repo',
        // pid intentionally absent
      },
      home
    );

    const mapping = readMappingJsonIn(sessionSidecarDir(home, 'poly-3'));
    assert.equal(Object.hasOwn(mapping, 'pid'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Refresh + migration semantics
// ---------------------------------------------------------------------------

test('writeCaptureMapping preserves firstSeenAt and bumps lastSeenAt on refresh', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-refresh');
    const baseArgs = {
      agentType: 'claude',
      agentSessionId: 'sess-refresh',
      polygraphSessionId: 'poly-refresh',
      cwd: '/original-cwd',
    };

    writeCaptureMapping(baseArgs, home);
    const first = readMappingJsonIn(sessionSidecarDir(home, 'poly-refresh'));

    // Ensure at least 1 ms passes so lastSeenAt can advance.
    const end = Date.now() + 2;
    while (Date.now() < end) { /* busy-wait */ }

    writeCaptureMapping({ ...baseArgs, cwd: '/updated-cwd' }, home);
    const second = readMappingJsonIn(sessionSidecarDir(home, 'poly-refresh'));

    assert.equal(second.firstSeenAt, first.firstSeenAt, 'firstSeenAt preserved');
    assert.ok(second.lastSeenAt > first.lastSeenAt, 'lastSeenAt advanced');
    assert.equal(second.cwd, '/updated-cwd', 'cwd updated on refresh');
    assert.equal(second.version, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping keeps firstSeenAt continuity when migrating a mapping from the legacy dir', () => {
  const home = makeHome();
  try {
    // Prior state from an older install: mapping in the legacy flat dir.
    const legacy = legacyDir(home, 'poly-migrate');
    mkdirSync(legacy, { recursive: true });
    const legacyPath = join(legacy, 'mapping-claude-sess-migrate.json');
    const legacyContent = JSON.stringify({
      version: 1,
      polygraphSessionId: 'poly-migrate',
      agentType: 'claude',
      agentSessionId: 'sess-migrate',
      cwd: '/old-cwd',
      source: 'hook',
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    });
    writeFileSync(legacyPath, legacyContent);

    // The session directory now exists, so the write routes to it.
    makeSessionDir(home, 'poly-migrate');

    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-migrate',
        polygraphSessionId: 'poly-migrate',
        cwd: '/repo',
      },
      home
    );

    const migrated = readMappingJsonIn(sessionSidecarDir(home, 'poly-migrate'));
    assert.equal(migrated.firstSeenAt, 1000, 'firstSeenAt carried over from the legacy mapping');
    assert.ok(migrated.lastSeenAt > 1000);
    assert.equal(migrated.cwd, '/repo');

    // The legacy copy is a read-only fallback: untouched, and not rewritten.
    assert.equal(readFileSync(legacyPath, 'utf8'), legacyContent);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping prefers the new-location mapping over the legacy one for firstSeenAt', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-both');
    const newDir = sessionSidecarDir(home, 'poly-both');
    mkdirSync(newDir, { recursive: true });
    const base = {
      version: 1,
      polygraphSessionId: 'poly-both',
      agentType: 'claude',
      agentSessionId: 'sess-both',
      cwd: '/x',
      source: 'hook',
      lastSeenAt: 1,
    };
    writeFileSync(
      join(newDir, 'mapping-claude-sess-both.json'),
      JSON.stringify({ ...base, firstSeenAt: 2000 })
    );
    const legacy = legacyDir(home, 'poly-both');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, 'mapping-claude-sess-both.json'),
      JSON.stringify({ ...base, firstSeenAt: 1000 })
    );

    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-both',
        polygraphSessionId: 'poly-both',
        cwd: '/repo',
      },
      home
    );

    const mapping = readMappingJsonIn(newDir);
    assert.equal(mapping.firstSeenAt, 2000, 'new-location firstSeenAt wins');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Filenames + hygiene
// ---------------------------------------------------------------------------

test('writeCaptureMapping writes to separate session dirs for different polygraphSessionIds', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-A');
    makeSessionDir(home, 'poly-B');
    for (const id of ['poly-A', 'poly-B']) {
      writeCaptureMapping(
        {
          agentType: 'claude',
          agentSessionId: 'sess-multi',
          polygraphSessionId: id,
          cwd: '/repo',
        },
        home
      );
    }

    for (const id of ['poly-A', 'poly-B']) {
      const mapping = readMappingJsonIn(sessionSidecarDir(home, id));
      assert.equal(mapping.polygraphSessionId, id);
      assert.ok(Number.isFinite(mapping.firstSeenAt));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping uses agentType in the filename', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-codex');
    writeCaptureMapping(
      {
        agentType: 'codex',
        agentSessionId: 'thread-codex-xyz',
        polygraphSessionId: 'poly-codex',
        cwd: '/repo',
      },
      home
    );

    const files = readMappingFilesIn(sessionSidecarDir(home, 'poly-codex'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^mapping-codex-/);

    const mapping = readMappingJsonIn(sessionSidecarDir(home, 'poly-codex'));
    assert.equal(mapping.agentType, 'codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping sanitizes special characters in the filename', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-sanitize');
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess/with spaces&special!chars',
        polygraphSessionId: 'poly-sanitize',
        cwd: '/repo',
      },
      home
    );

    const files = readMappingFilesIn(sessionSidecarDir(home, 'poly-sanitize'));
    assert.equal(files.length, 1);
    // Filename must only contain safe characters (besides the mandatory
    // mapping- prefix and .json suffix).
    assert.match(files[0], /^mapping-[A-Za-z0-9._-]+\.json$/);
    assert.doesNotMatch(files[0], /[/ !&]/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping leaves no tmp file after a successful write', () => {
  const home = makeHome();
  try {
    makeSessionDir(home, 'poly-atomic');
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-atomic',
        polygraphSessionId: 'poly-atomic',
        cwd: '/repo',
      },
      home
    );

    const dir = sessionSidecarDir(home, 'poly-atomic');
    const tmpFiles = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.equal(tmpFiles.length, 0, 'no leftover tmp files');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping creates intermediate directories from scratch (legacy fallback)', () => {
  const home = makeHome();
  try {
    // Confirm ~/.polygraph does not exist yet — so no session dir either,
    // and the write falls back to the legacy flat dir.
    assert.equal(existsSync(join(home, '.polygraph')), false);

    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-mkdir',
        polygraphSessionId: 'poly-fresh',
        cwd: '/repo',
      },
      home
    );

    assert.ok(existsSync(legacyDir(home, 'poly-fresh')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
