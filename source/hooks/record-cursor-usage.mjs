/**
 * Cursor `stop` hook: append the turn's token usage to the Polygraph cursor
 * usage ledger at `~/.polygraph/cursor-usage/<conversation_id>.jsonl`.
 *
 * Cursor leaves no readable usage artifact of its own (the flat transcript
 * stores none, the chat store is encrypted), so interactive sessions must
 * capture usage the moment cursor reports it: the `stop` hook payload
 * carries snake_case counters plus `generation_id` per turn (live-verified
 * on cursor-agent 2026.08.25-3e8eec8). The Polygraph CLI's token-cost
 * collector reads the ledger back when it reports session costs.
 *
 * REGISTRATION: cursor does NOT dispatch `stop` from `--plugin-dir` plugin
 * hooks (only a subset, e.g. sessionStart; live-verified 2026-08-27), so the
 * installer merges a user-scope entry into `~/.cursor/hooks.json` pointing
 * at this script by absolute path. The plugin's own hooks.json also lists it
 * so a future cursor build that dispatches plugin `stop` works unchanged;
 * per-generation dedupe at read time keeps a double dispatch from double
 * counting.
 *
 * CROSS-REPO CONTRACT: record shape, filename scheme, id validation, and the
 * `POLYGRAPH_CURSOR_USAGE_DIR` override match `cursor-usage-ledger.ts` in
 * nrwl/ocean (the reader, and the headless writer inside the cursor driver).
 * Change them together.
 *
 * Managed child agents are skipped (`POLYGRAPH_CHILD_AGENT` env): their
 * headless turns are recorded by the Polygraph cursor driver from the stream
 * `result` event, and recording here too would double count.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logHookFailure } from './agent-session-link.mjs';

const LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getCursorUsageLedgerDir(env = process.env) {
  const override = env.POLYGRAPH_CURSOR_USAGE_DIR?.trim();
  if (override) return override;
  const home = env.HOME?.trim() || homedir();
  return join(home, '.polygraph', 'cursor-usage');
}

/** Conservative id shape shared with the ocean-side reader. */
export function isValidCursorConversationId(value) {
  return (
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
  );
}

function counter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/**
 * Build the ledger record from a stop payload, or null when the payload does
 * not carry usable usage.
 */
export function buildCursorUsageRecord(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.hook_event_name !== 'stop') return null;
  const conversationId = payload.conversation_id ?? payload.session_id;
  if (!isValidCursorConversationId(conversationId)) return null;

  const inputTokens = counter(payload.input_tokens);
  const outputTokens = counter(payload.output_tokens);
  const cacheReadTokens = counter(payload.cache_read_tokens);
  const cacheWriteTokens = counter(payload.cache_write_tokens);
  // A payload with no counters at all records nothing; individual missing
  // counters read as zero so a partial payload still lands.
  if (
    inputTokens === null &&
    outputTokens === null &&
    cacheReadTokens === null &&
    cacheWriteTokens === null
  ) {
    return null;
  }

  return {
    recordedAt: now,
    conversationId,
    requestId: null,
    generationId:
      typeof payload.generation_id === 'string' && payload.generation_id !== ''
        ? payload.generation_id
        : null,
    model:
      typeof payload.model === 'string' && payload.model !== ''
        ? payload.model
        : null,
    source: 'stop-hook',
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  };
}

/**
 * Drop ledger files older than 30 days so ordinary cursor use cannot grow
 * the dir forever. Best-effort; mirrors the ocean-side pruning.
 */
export function pruneLedgerDir(dir, now = Date.now()) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const path = join(dir, entry);
    try {
      if (now - statSync(path).mtimeMs > LEDGER_MAX_AGE_MS) {
        rmSync(path, { force: true });
      }
    } catch {
      // Another process may be pruning concurrently.
    }
  }
}

function readPayload() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function main({
  payload = readPayload(),
  env = process.env,
  now = Date.now(),
} = {}) {
  try {
    // Managed children are recorded by the Polygraph cursor driver.
    if (env && Object.hasOwn(env, 'POLYGRAPH_CHILD_AGENT')) return false;

    const record = buildCursorUsageRecord(payload, now);
    if (!record) return false;

    const dir = getCursorUsageLedgerDir(env);
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, `${record.conversationId}.jsonl`),
      `${JSON.stringify(record)}\n`
    );
    pruneLedgerDir(dir, now);
    return true;
  } catch (error) {
    logHookFailure('cursor:record-cursor-usage', error, {
      hookEventName: payload?.hook_event_name,
      agentSessionId: payload?.conversation_id ?? payload?.session_id,
    });
    return false;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
