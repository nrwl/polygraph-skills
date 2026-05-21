import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import { renderArtifact, rootDir } from '../scripts/src/sync-artifacts/common.mjs';
import { processAgents } from '../scripts/src/sync-artifacts/processors.mjs';
import {
  buildCodexPluginManifest,
  buildMcpConfig,
  readRootPackageJson,
} from '../scripts/src/sync-artifacts/package-artifacts.mjs';

function renderSkill(skillName, platform = 'codex') {
  const raw = readFileSync(join(rootDir, 'source', 'skills', skillName, 'SKILL.md'), 'utf8');
  return renderArtifact(raw, platform);
}

function assertNoNonCodexDelegationText(rendered) {
  assert.doesNotMatch(rendered, /Task\(/);
  assert.doesNotMatch(rendered, /subagent_type:/);
  assert.doesNotMatch(rendered, /run_in_background/);
  assert.doesNotMatch(rendered, /@polygraph-delegate-subagent/);
}

const legacyStreamLogPattern = new RegExp(['streaming', 'logs'].join(' '));
const legacyExternalCiLogPattern = new RegExp(['external CI', 'logs'].join(' '));

test('renderArtifact preserves a valid frontmatter boundary for the codex polygraph skill', () => {
  const rendered = renderSkill('polygraph');

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

test('rendered polygraph skill documents same-installation shared session metadata', () => {
  const rendered = renderSkill('polygraph');

  assert.match(rendered, /same-installation shared Polygraph session/);
  assert.match(rendered, /share-<sessionObjectId>/);
  assert.match(rendered, /canonical identifier is `sharedSessionId`/);
  assert.match(rendered, /\/s\/:sharedSessionId` URL is only a convenience route in the current configured Polygraph app/);
  assert.match(rendered, /origin is not canonical/);
  assert.match(rendered, /current `polygraphSessionUrl`/);
  assert.match(rendered, /Shared reads intentionally hide linked sessions and resume controls/);
  assert.match(rendered, /do not call `link_session`/);
  assert.match(rendered, /external CI information and job logs are unavailable/);
  assert.doesNotMatch(rendered, /step\/log read URLs/);
  assert.doesNotMatch(rendered, legacyStreamLogPattern);
  assert.doesNotMatch(rendered, legacyExternalCiLogPattern);
});

test('codex polygraph skill uses custom Codex subagent guidance', () => {
  const rendered = renderSkill('polygraph');

  assert.match(rendered, /agent_type: "polygraph-init-subagent"/);
  assert.match(rendered, /agent_type: "polygraph-delegate-subagent"/);
  assert.match(rendered, /Codex `spawn_agent` ≠ Polygraph MCP `spawn_agent`/);
  assert.match(rendered, /`wait_agent`/);
  assert.match(rendered, /Resume is not a work command/);
  assert.match(rendered, /Treat "resume" as context restoration followed by waiting for user instructions/);
  assert.match(rendered, /- repo: "<org\/repo-name>"/);
  assert.match(rendered, /repo: "org\/repo-name"/);
  assert.doesNotMatch(rendered, /- target: "<org\/repo-name>"/);
  assert.doesNotMatch(rendered, /target: "org\/repo-name"/);
  assertNoNonCodexDelegationText(rendered);
});

test('codex CI skills include built-in subagent guidance', () => {
  const getLatestCi = renderSkill('get-latest-ci');
  const awaitPolygraphCi = renderSkill('await-polygraph-ci');

  assert.match(getLatestCi, /Use a Codex built-in subagent to call the MCP tool/);
  assert.match(getLatestCi, /Always delegate the MCP call to a Codex built-in subagent/);
  assert.match(getLatestCi, /`wait_agent`/);

  assert.match(awaitPolygraphCi, /Codex subagent wrapper/);
  assert.match(awaitPolygraphCi, /agent_type: "polygraph-delegate-subagent"/);
  assert.match(awaitPolygraphCi, /the delegate-and-poll loop should run inside `polygraph-delegate-subagent`/);
  assert.match(awaitPolygraphCi, /show_agent\(sessionId: "<session-id>", repo: "frontend"\)/);
  assert.doesNotMatch(awaitPolygraphCi, /show_agent\(sessionId: "<session-id>", target: "frontend"\)/);
  assert.match(awaitPolygraphCi, /`wait_agent`/);
  assert.match(awaitPolygraphCi, /same-installation `sharedSessionId` values/);
  assert.match(awaitPolygraphCi, /\/s\/:sharedSessionId` is only a current-app convenience URL whose origin is not canonical/);
  assert.match(awaitPolygraphCi, /CI monitoring is unavailable for shared sessions/);
  assert.match(awaitPolygraphCi, /Shared `sharedSessionId` values cannot retrieve external CI job logs/);
  assert.doesNotMatch(awaitPolygraphCi, /step\/log read URLs/);
  assert.doesNotMatch(awaitPolygraphCi, legacyStreamLogPattern);
  assert.doesNotMatch(awaitPolygraphCi, legacyExternalCiLogPattern);

  assertNoNonCodexDelegationText(getLatestCi);
  assertNoNonCodexDelegationText(awaitPolygraphCi);
});

test('pack-and-copy skill keeps consumer CI installable', () => {
  const rendered = renderSkill('pack-and-copy');

  assert.match(rendered, /including `\.polygraph-packages\/\*\.tgz`/);
  assert.match(rendered, /Fresh CI clones need those tarballs/);
  assert.match(rendered, /`npm install`, `pnpm install`, or `yarn install`/);
  assert.match(rendered, /On reruns in the same worktree/);
  assert.match(rendered, /`npm install --force`, `pnpm install --force`, or `yarn install --force`/);
  assert.doesNotMatch(rendered, /added to `\.gitignore` automatically/);
});

test('codex agents render as valid custom agent TOML', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'polygraph-codex-agents-'));

  processAgents('codex', {
    outputDir,
    supportsAgents: true,
    agentsDir: 'agents',
    agentsExt: '.toml',
    agentsFormat: 'toml',
  });

  const initAgent = parse(
    readFileSync(join(outputDir, 'agents', 'polygraph-init-subagent.toml'), 'utf8')
  );
  const delegateAgent = parse(
    readFileSync(join(outputDir, 'agents', 'polygraph-delegate-subagent.toml'), 'utf8')
  );

  assert.equal(initAgent.name, 'polygraph-init-subagent');
  assert.match(initAgent.description, /initializes a Polygraph session/);
  assert.match(initAgent.description, /shared `sharedSessionId`/);
  assert.match(initAgent.developer_instructions, /# Polygraph Init Subagent/);
  assert.match(initAgent.developer_instructions, /Do NOT call `spawn_agent`/);
  assert.match(initAgent.developer_instructions, /Shared sessions .* are read-only metadata/);

  assert.equal(delegateAgent.name, 'polygraph-delegate-subagent');
  assert.match(delegateAgent.description, /Delegates work to a child agent/);
  assert.match(delegateAgent.developer_instructions, /# Polygraph Delegate Subagent/);
  assert.match(delegateAgent.developer_instructions, /Backoff schedule for polling/);
  assert.match(delegateAgent.developer_instructions, /Resume\/reconstruction is read-only/);
  assert.match(delegateAgent.developer_instructions, /Shared sessions are read-only/);
  assert.match(delegateAgent.developer_instructions, /After resuming, wait for explicit user instructions/);
});

test('codex plugin manifest does not advertise agents (codex ignores the field)', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(manifest.agents, undefined);
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
