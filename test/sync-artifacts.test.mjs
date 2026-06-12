import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import { renderArtifact, rootDir } from '../scripts/src/sync-artifacts/common.mjs';
import { processAgents } from '../scripts/src/sync-artifacts/processors.mjs';
import {
  buildCodexPluginManifest,
  buildMcpConfig,
  buildOpenCodePackageJson,
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

test('rendered polygraph skill documents linked references', () => {
  const raw = readFileSync(join(rootDir, 'source', 'skills', 'polygraph', 'SKILL.md'), 'utf8');
  const rendered = renderArtifact(raw, 'codex');

  assert.match(rendered, /`link_reference` for linking external references to sessions/);
  assert.match(rendered, /`link_reference` \| — \| Link an external reference to a session\./);
  assert.match(rendered, /session\.linkedReferences/);
  assert.match(rendered, /### Linked References/);
  assert.match(rendered, /When an external resource is mentioned during a Polygraph session and appears relevant to the current work/);
  assert.match(rendered, /record it with `link_reference\(\{ sessionId, reference \}\)`/);
  assert.match(rendered, /pull requests, GitHub issues, other Polygraph sessions, and Linear issues/);
  assert.match(rendered, /Invoke the MCP tool with a single object containing `\{ sessionId, reference \}`/);
  assert.match(rendered, /For example, to record a relevant pull request/);
  assert.match(rendered, /link_reference\(\{/);
  assert.match(rendered, /sessionId: "<current-session-id>"/);
  assert.match(rendered, /reference: \{/);
  assert.match(rendered, /type: "github_pr"/);
  assert.match(rendered, /url: "https:\/\/github\.com\/nrwl\/polygraph-skills\/pull\/123"/);
  assert.match(rendered, /label: "Implementation PR"/);
  assert.match(rendered, /To record a relevant Polygraph session, use the same invocation shape and include `reference\.sessionId`/);
  assert.match(rendered, /type: "session"/);
  assert.match(rendered, /label: "Inspected Polygraph session"/);
  assert.match(rendered, /sessionId: "<inspected-session-id>"/);
  assert.match(rendered, /The canonical MCP parameters are `\{ sessionId, reference \}`/);
  assert.match(rendered, /polygraph session show --details <session-id>/);

  const printSection = sectionBetween(rendered, '### Print Polygraph Session Details', '## Best Practices');
  assert.doesNotMatch(printSection, /link_reference/);
  assert.doesNotMatch(printSection, /linked reference/);

  assert.doesNotMatch(rendered, /link_session/);
  assert.doesNotMatch(rendered, /polygraph session link/);
  assert.doesNotMatch(rendered, /linkedSessions/);
  assert.doesNotMatch(rendered, /targetSessionId/);
  assert.doesNotMatch(rendered, /linkedSessionId/);
  assert.doesNotMatch(rendered, /Record a linked reference on a session/);
  assert.doesNotMatch(rendered, /Repeat the link step every time a session is inspected this way/);
  assert.doesNotMatch(rendered, /always link the inspected session/);
  assert.doesNotMatch(rendered, /Print the inspected session details for the user/);
  assert.doesNotMatch(rendered, /--(?:target|dependency|dependent)Id\b|\b(?:target|dependency|dependent)Id:/);
});

test('rendered polygraph skill documents session description policy guidance', () => {
  const rendered = renderSkill('polygraph');
  const policySection = sectionBetween(
    rendered,
    '### Session Description Policy',
    '### 3. Create Draft PRs'
  );
  const createPrSection = sectionBetween(
    rendered,
    '### 3. Create Draft PRs',
    '### 4. Get Current Polygraph Session'
  );
  const markPrReadySection = sectionBetween(
    rendered,
    '### 5. Mark PRs Ready',
    '### 6. Associate Existing PRs'
  );
  const associatePrSection = sectionBetween(
    rendered,
    '### 6. Associate Existing PRs',
    '### 7. Add Repositories to a Session'
  );
  const updateDescriptionSection = sectionBetween(
    rendered,
    '### Update Session Description',
    '### Print Polygraph Session Details'
  );

  assert.match(rendered, /`update_session_description` \| `polygraph session update-description`/);
  assert.match(rendered, /`update_session_description` for session metadata updates/);
  assert.match(policySection, /`description` is user-facing Polygraph session context/);
  assert.match(policySection, /`create_pr`, `mark_pr_ready`, `associate_pr`, and `update_session_description`/);
  assert.match(policySection, /Goal: <what the session is trying to accomplish>/);
  assert.match(policySection, /Current Progress: <what has been completed so far, including PR\/session state when relevant>/);
  assert.match(policySection, /What Worked: <important decisions, approaches, or constraints that future agents should preserve>/);
  assert.match(policySection, /Next Steps: <clear next implementation steps>/);
  assert.match(policySection, /Do not use a one-line feature summary/);
  assert.match(policySection, /Keep it concise but durable for a future resumed agent/);
  assert.match(policySection, /Prefer high-level state over file-by-file changelogs/);
  assert.match(policySection, /Mention unresolved decisions or risks when they matter/);
  assert.match(policySection, /include only next implementation steps/);
  assert.match(createPrSection, /must follow the Session Description Policy/);
  assert.match(markPrReadySection, /must follow the Session Description Policy/);
  assert.match(associatePrSection, /must follow the Session Description Policy/);
  assert.match(updateDescriptionSection, /canonical structured format in the Session Description Policy/);
  assert.match(updateDescriptionSection, /Read the current session details\./);
  assert.match(updateDescriptionSection, /child-agent results, PRs, pushed branches, validation, and unresolved decisions/);
  assert.match(updateDescriptionSection, /Then call `update_session_description` with the resulting summary\./);
  assert.doesNotMatch(updateDescriptionSection, /\*\*Parameters:\*\*/);
  assert.doesNotMatch(updateDescriptionSection, /Do not pass `agentSessionId` to this tool/);
  assert.doesNotMatch(updateDescriptionSection, /CLI\/MCP layer captures or derives the agent session ID automatically/);
  assert.doesNotMatch(rendered, /description: "Add user preferences feature: UI in frontend, API in backend"/);
  assert.doesNotMatch(rendered, /description: "Register fork PR for user preferences UI"/);
  assert.doesNotMatch(rendered, /Session Description Summary/);
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

test('rendered polygraph skill keeps session intro as hidden internal fallback', () => {
  const rendered = renderSkill('polygraph');
  const toolsSection = sectionBetween(rendered, '## Available Tools', '## CLI Statefulness');

  assert.match(rendered, /`session_intro` MCP tool/);
  assert.match(rendered, /`polygraph session intro -s <sessionId>`/);
  assert.match(rendered, /intentionally hidden\/internal and may not appear in public command listings/);
  assert.doesNotMatch(toolsSection, /polygraph session intro/);
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

test('opencode agents render as markdown subagents for plugin registration', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'polygraph-opencode-agents-'));

  processAgents('opencode', {
    outputDir,
    supportsAgents: true,
    agentsDir: 'agents',
    agentsExt: '.md',
  });

  const initAgent = readFileSync(join(outputDir, 'agents', 'polygraph-init-subagent.md'), 'utf8');
  const delegateAgent = readFileSync(join(outputDir, 'agents', 'polygraph-delegate-subagent.md'), 'utf8');

  assert.match(initAgent, /^---\n\s*description: Discovers candidate repositories/);
  assert.match(initAgent, /\nmode: subagent\n\s*---\n/);
  assert.match(initAgent, /# Polygraph Init Subagent/);
  assert.doesNotMatch(initAgent, /^name = /m);

  assert.match(delegateAgent, /^---\n\s*description: Delegates work to a child agent/);
  assert.match(delegateAgent, /\nmode: subagent\n\s*---\n/);
  assert.match(delegateAgent, /# Polygraph Delegate Subagent/);
  assert.doesNotMatch(delegateAgent, /^developer_instructions = /m);
});

test('opencode skill names are native-compatible and match their directories', () => {
  const skillsDir = join(rootDir, 'source', 'skills');

  for (const entry of readdirSync(skillsDir)) {
    if (!statSync(join(skillsDir, entry)).isDirectory()) continue;

    const rendered = renderSkill(entry, 'opencode');
    const name = rendered.match(/^name:\s*(.+)$/m)?.[1].trim();

    assert.equal(name, entry);
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(name.length <= 64);
  }
});

test('codex plugin manifest does not advertise agents (codex ignores the field)', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(manifest.agents, undefined);
});

test('codex plugin manifest registers the bundled SessionStart hooks file', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(manifest.hooks, './hooks/hooks.json');
});

test('opencode package is published as a native plugin package', () => {
  const pkg = buildOpenCodePackageJson(readRootPackageJson());

  assert.equal(pkg.name, '@polygraph/opencode-plugin');
  assert.equal(pkg.private, false);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.exports, { './server': './server.js' });
  assert.equal(pkg.main, './server.js');
  assert.deepEqual(pkg.dependencies, { 'js-yaml': '^4.1.1' });
  assert.deepEqual(pkg.files, ['server.js', 'skills/', 'agents/', 'README.md']);
});

test('buildMcpConfig wraps MCP servers under mcpServers', () => {
  assert.deepEqual(buildMcpConfig(), {
    mcpServers: {
      'polygraph-mcp': {
        type: 'stdio',
        command: 'npx',
        args: ['@polygraph/mcp@latest'],
      },
    },
  });
});
