import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeCaptureMapping } from '../source/hooks/record-session-mapping.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'pg-mapping-'));
}

function sidecarDir(home, polygraphSessionId) {
  return join(home, '.polygraph', 'sidecars', polygraphSessionId);
}

function readMappingFiles(home, polygraphSessionId) {
  const dir = sidecarDir(home, polygraphSessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith('mapping-'));
}

function readMappingJson(home, polygraphSessionId) {
  const files = readMappingFiles(home, polygraphSessionId);
  assert.equal(files.length, 1, 'expected exactly one mapping file');
  return JSON.parse(
    readFileSync(join(sidecarDir(home, polygraphSessionId), files[0]), 'utf8')
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('writeCaptureMapping creates the sidecar directory and a mapping-*.json file', () => {
  const home = makeHome();
  try {
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-abc-123',
        polygraphSessionId: 'poly-xyz',
        cwd: '/some/project',
      },
      home
    );

    assert.ok(existsSync(sidecarDir(home, 'poly-xyz')), 'sidecar dir created');

    const files = readMappingFiles(home, 'poly-xyz');
    assert.equal(files.length, 1);
    assert.match(files[0], /^mapping-claude-sess-abc-123\.json$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping writes all required fields with correct values', () => {
  const home = makeHome();
  try {
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

    const mapping = readMappingJson(home, 'poly-1');

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

    const mapping = readMappingJson(home, 'poly-2');
    assert.equal(Object.hasOwn(mapping, 'transcriptPath'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping omits transcriptPath when explicitly null', () => {
  const home = makeHome();
  try {
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

    const mapping = readMappingJson(home, 'poly-null-tp');
    assert.equal(Object.hasOwn(mapping, 'transcriptPath'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping omits pid when not provided', () => {
  const home = makeHome();
  try {
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

    const mapping = readMappingJson(home, 'poly-3');
    assert.equal(Object.hasOwn(mapping, 'pid'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping preserves firstSeenAt and bumps lastSeenAt on refresh', () => {
  const home = makeHome();
  try {
    const baseArgs = {
      agentType: 'claude',
      agentSessionId: 'sess-refresh',
      polygraphSessionId: 'poly-refresh',
      cwd: '/original-cwd',
    };

    writeCaptureMapping(baseArgs, home);
    const first = readMappingJson(home, 'poly-refresh');

    // Ensure at least 1 ms passes so lastSeenAt can advance.
    const end = Date.now() + 2;
    while (Date.now() < end) { /* busy-wait */ }

    writeCaptureMapping({ ...baseArgs, cwd: '/updated-cwd' }, home);
    const second = readMappingJson(home, 'poly-refresh');

    assert.equal(second.firstSeenAt, first.firstSeenAt, 'firstSeenAt preserved');
    assert.ok(second.lastSeenAt > first.lastSeenAt, 'lastSeenAt advanced');
    assert.equal(second.cwd, '/updated-cwd', 'cwd updated on refresh');
    assert.equal(second.version, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping writes to separate directories for different polygraphSessionIds', () => {
  const home = makeHome();
  try {
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-multi',
        polygraphSessionId: 'poly-A',
        cwd: '/repo',
      },
      home
    );
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-multi',
        polygraphSessionId: 'poly-B',
        cwd: '/repo',
      },
      home
    );

    const mappingA = readMappingJson(home, 'poly-A');
    const mappingB = readMappingJson(home, 'poly-B');

    assert.equal(mappingA.polygraphSessionId, 'poly-A');
    assert.equal(mappingB.polygraphSessionId, 'poly-B');
    assert.ok(Number.isFinite(mappingA.firstSeenAt));
    assert.ok(Number.isFinite(mappingB.firstSeenAt));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping uses agentType in the filename', () => {
  const home = makeHome();
  try {
    writeCaptureMapping(
      {
        agentType: 'codex',
        agentSessionId: 'thread-codex-xyz',
        polygraphSessionId: 'poly-codex',
        cwd: '/repo',
      },
      home
    );

    const files = readMappingFiles(home, 'poly-codex');
    assert.equal(files.length, 1);
    assert.match(files[0], /^mapping-codex-/);

    const mapping = readMappingJson(home, 'poly-codex');
    assert.equal(mapping.agentType, 'codex');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping sanitizes special characters in the filename', () => {
  const home = makeHome();
  try {
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess/with spaces&special!chars',
        polygraphSessionId: 'poly-sanitize',
        cwd: '/repo',
      },
      home
    );

    const files = readMappingFiles(home, 'poly-sanitize');
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
    writeCaptureMapping(
      {
        agentType: 'claude',
        agentSessionId: 'sess-atomic',
        polygraphSessionId: 'poly-atomic',
        cwd: '/repo',
      },
      home
    );

    const dir = sidecarDir(home, 'poly-atomic');
    const tmpFiles = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    assert.equal(tmpFiles.length, 0, 'no leftover tmp files');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCaptureMapping creates intermediate directories from scratch', () => {
  const home = makeHome();
  try {
    // Confirm ~/.polygraph does not exist yet.
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

    assert.ok(existsSync(sidecarDir(home, 'poly-fresh')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
