import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  logHookFailure,
  writeAgentCaptureMapping,
} from '../source/opencode/agent-capture-mapping.mjs';

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'pg-hook-log-'));
}

function logPath(home) {
  return join(home, '.polygraph', 'logs', 'hooks.log');
}

test('logHookFailure appends a parseable JSONL entry under ~/.polygraph/logs', () => {
  const home = makeHome();
  try {
    logHookFailure('some:hook', new Error('boom'), { sessionID: 's-1' }, home);

    const raw = readFileSync(logPath(home), 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.hook, 'some:hook');
    assert.equal(entry.error, 'boom');
    assert.equal(entry.sessionID, 's-1');
    assert.ok(typeof entry.time === 'string' && entry.time.length > 0);
    assert.ok(typeof entry.stack === 'string' && entry.stack.includes('boom'));
    assert.ok(Number.isFinite(entry.pid));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailure appends (does not overwrite) across calls', () => {
  const home = makeHome();
  try {
    logHookFailure('h1', new Error('first'), {}, home);
    logHookFailure('h2', new Error('second'), {}, home);

    const lines = readFileSync(logPath(home), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).hook, 'h1');
    assert.equal(JSON.parse(lines[1]).hook, 'h2');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailure stringifies non-Error throw values without a stack', () => {
  const home = makeHome();
  try {
    logHookFailure('h', 'plain string failure', {}, home);

    const entry = JSON.parse(readFileSync(logPath(home), 'utf8').trim());
    assert.equal(entry.error, 'plain string failure');
    assert.equal(Object.hasOwn(entry, 'stack'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailure rotates the log once it exceeds the size cap', () => {
  const home = makeHome();
  try {
    // Seed an oversized log (> 5 MiB) so the next write triggers rotation.
    logHookFailure('seed', new Error('seed'), {}, home); // creates the dir
    writeFileSync(logPath(home), 'x'.repeat(5 * 1024 * 1024 + 10));

    logHookFailure('after-rotate', new Error('post'), {}, home);

    assert.ok(existsSync(`${logPath(home)}.1`), 'rotated file exists');
    const current = readFileSync(logPath(home), 'utf8').trim();
    // Current log holds only the post-rotation entry.
    assert.equal(current.split('\n').length, 1);
    assert.equal(JSON.parse(current).hook, 'after-rotate');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logHookFailure never throws, even with an unusable home', () => {
  // A path under an existing *file* cannot be turned into a directory; mkdirSync
  // throws internally, and the logger must swallow it.
  const home = makeHome();
  try {
    const filePath = join(home, 'not-a-dir');
    writeFileSync(filePath, 'i am a file');
    assert.doesNotThrow(() =>
      logHookFailure('h', new Error('boom'), {}, filePath)
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeAgentCaptureMapping no-op paths do not write a failure log', () => {
  const saved = process.env.POLYGRAPH_SESSION_ID;
  const home = makeHome();
  try {
    delete process.env.POLYGRAPH_SESSION_ID; // forces the silent no-op path
    writeAgentCaptureMapping('ses', home);
    assert.equal(existsSync(logPath(home)), false, 'no log for a clean no-op');
  } finally {
    if (saved === undefined) delete process.env.POLYGRAPH_SESSION_ID;
    else process.env.POLYGRAPH_SESSION_ID = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
