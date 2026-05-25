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

function sectionBetween(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1);
  return content.slice(startIndex, endIndex);
}

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

test('rendered polygraph skill documents standalone session description updates', () => {
  const rendered = renderSkill('polygraph');
  const descriptionSection = sectionBetween(
    rendered,
    '### Session Description',
    '### Print Polygraph Session Details'
  );
  const parametersSection = sectionBetween(
    descriptionSection,
    '**Parameters:**',
    '\n\n```'
  );

  assert.match(rendered, /`update_session_description` \| `polygraph session update-description`/);
  assert.match(rendered, /`update_session_description` for session metadata updates/);
  assert.match(descriptionSection, /`update_session_description` or `polygraph session update-description`/);
  assert.match(descriptionSection, /set, update, refresh, or summarize the Polygraph session description/);
  assert.match(descriptionSection, /user-provided text or from a concise progress summary/);
  assert.doesNotMatch(parametersSection, /agentSessionId/);
  assert.doesNotMatch(descriptionSection, /Do not pass `agentSessionId` to this tool/);
  assert.doesNotMatch(descriptionSection, /CLI\/MCP layer captures or derives the agent session ID automatically/);
  assert.match(descriptionSection, /For append-style requests, update the full description body/);
  assert.match(descriptionSection, /read the latest\/current description/);
  assert.match(descriptionSection, /Compose one complete updated description/);
  assert.doesNotMatch(descriptionSection, /\bbackend\b/i);
  assert.doesNotMatch(descriptionSection, /timeline|current author/);
  assert.match(rendered, /Do not call `create_pr`, `mark_pr_ready`, or `associate_pr` just to update the session description/);
  assert.doesNotMatch(rendered, /cloud_polygraph_create_prs/);
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

test('rendered polygraph skill documents PR repository semantics', () => {
  const rendered = renderSkill('polygraph');
  const createPrSection = sectionBetween(
    rendered,
    '### 3. Create Draft PRs',
    '### 4. Get Current Polygraph Session'
  );
  const associatePrSection = sectionBetween(
    rendered,
    '### 6. Associate Existing PRs',
    '### 7. Add Repositories to a Session'
  );

  assert.match(createPrSection, /`targetRepository` \(optional\): Target GitHub repository for fork PR creation or registration/);
  assert.match(createPrSection, /keep `owner` and `repo` set to the source repository/);
  assert.match(createPrSection, /targetRepository: "org\/frontend"/);

  assert.match(associatePrSection, /Provide either a `prUrl` to associate a specific PR, or a `branch` name plus `repo` to find and associate PRs for a source repository\./);
  assert.match(associatePrSection, /- `repo` \(optional\): Source repository for branch-based association/);
  assert.match(associatePrSection, /repo: "org\/repo"/);
  assert.doesNotMatch(associatePrSection, /URL-based association infers|Branch-based association uses/);
  assert.doesNotMatch(associatePrSection, /targetRepo|targetRepository/);
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
  assert.match(initAgent.developer_instructions, /# Polygraph Init Subagent/);
  assert.match(initAgent.developer_instructions, /Do NOT call `spawn_agent`/);

  assert.equal(delegateAgent.name, 'polygraph-delegate-subagent');
  assert.match(delegateAgent.description, /Delegates work to a child agent/);
  assert.match(delegateAgent.developer_instructions, /# Polygraph Delegate Subagent/);
  assert.match(delegateAgent.developer_instructions, /Backoff schedule for polling/);
  assert.match(delegateAgent.developer_instructions, /Resume\/reconstruction is read-only/);
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
