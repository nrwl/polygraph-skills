import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCursorUsageRecord,
  isValidCursorConversationId,
  main,
  pruneLedgerDir,
} from '../source/hooks/record-cursor-usage.mjs';

const STOP_PAYLOAD = {
  conversation_id: 'c9a12f52-d3e2-4cf0-bf7f-60d1cf7ad18d',
  generation_id: '4fcd82f9-2af7-4597-ac45-9016e3f3eb24',
  model: 'default',
  status: 'completed',
  loop_count: 0,
  input_tokens: 20221,
  output_tokens: 45,
  cache_read_tokens: 7744,
  cache_write_tokens: 0,
  session_id: 'c9a12f52-d3e2-4cf0-bf7f-60d1cf7ad18d',
  hook_event_name: 'stop',
  cursor_version: '2026.08.25-3e8eec8',
};

function makeLedgerEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'polygraph-cursor-usage-'));
  return { dir, env: { POLYGRAPH_CURSOR_USAGE_DIR: dir } };
}

test('main appends a ledger record for a stop payload', () => {
  const { dir, env } = makeLedgerEnv();

  assert.equal(main({ payload: STOP_PAYLOAD, env, now: 123 }), true);

  const lines = readFileSync(
    join(dir, `${STOP_PAYLOAD.conversation_id}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    recordedAt: 123,
    conversationId: STOP_PAYLOAD.conversation_id,
    requestId: null,
    generationId: STOP_PAYLOAD.generation_id,
    model: 'default',
    source: 'stop-hook',
    inputTokens: 20221,
    outputTokens: 45,
    cacheReadTokens: 7744,
    cacheWriteTokens: 0,
  });
});

test('main skips managed child agents', () => {
  const { env } = makeLedgerEnv();
  assert.equal(
    main({ payload: STOP_PAYLOAD, env: { ...env, POLYGRAPH_CHILD_AGENT: '1' } }),
    false
  );
});

test('main ignores non-stop payloads and payloads without counters', () => {
  const { env } = makeLedgerEnv();
  assert.equal(
    main({ payload: { ...STOP_PAYLOAD, hook_event_name: 'sessionStart' }, env }),
    false
  );
  assert.equal(
    main({
      payload: {
        conversation_id: STOP_PAYLOAD.conversation_id,
        hook_event_name: 'stop',
      },
      env,
    }),
    false
  );
  // null skips the stdin-reading default without being a usable payload.
  assert.equal(main({ payload: null, env }), false);
});

test('buildCursorUsageRecord rejects hostile conversation ids', () => {
  for (const id of ['../evil', '.hidden', '', 'a/b']) {
    assert.equal(isValidCursorConversationId(id), false);
    assert.equal(
      buildCursorUsageRecord({
        ...STOP_PAYLOAD,
        conversation_id: id,
        session_id: id,
      }),
      null
    );
  }
});

test('buildCursorUsageRecord falls back to session_id and zero-fills partial counters', () => {
  const record = buildCursorUsageRecord(
    {
      session_id: STOP_PAYLOAD.session_id,
      hook_event_name: 'stop',
      output_tokens: 12,
    },
    5
  );
  assert.deepEqual(record, {
    recordedAt: 5,
    conversationId: STOP_PAYLOAD.session_id,
    requestId: null,
    generationId: null,
    model: null,
    source: 'stop-hook',
    inputTokens: 0,
    outputTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test('pruneLedgerDir removes only files older than the age limit', () => {
  const { dir, env } = makeLedgerEnv();
  main({ payload: STOP_PAYLOAD, env, now: Date.now() });
  const oldFile = join(dir, 'old-chat.jsonl');
  writeFileSync(oldFile, '{}\n');
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, past, past);

  pruneLedgerDir(dir);

  const remaining = readFileSync(
    join(dir, `${STOP_PAYLOAD.conversation_id}.jsonl`),
    'utf8'
  );
  assert.equal(remaining.trim().split('\n').length, 1);
  assert.throws(() => readFileSync(oldFile, 'utf8'));
});
