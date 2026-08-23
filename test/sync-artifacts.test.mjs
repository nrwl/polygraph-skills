import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import { renderArtifact, rootDir } from '../scripts/src/sync-artifacts/common.mjs';
import { processAgents, processSkills } from '../scripts/src/sync-artifacts/processors.mjs';
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

function renderAgent(agentName, platform = 'codex') {
  const raw = readFileSync(join(rootDir, 'source', 'agents', agentName, 'AGENT.md'), 'utf8');
  return renderArtifact(raw, platform);
}

function assertNoNonCodexDelegationText(rendered) {
  assert.doesNotMatch(rendered, /Task\(/);
  assert.doesNotMatch(rendered, /subagent_type:/);
  assert.doesNotMatch(rendered, /run_in_background/);
  assert.doesNotMatch(rendered, /@polygraph-delegate-subagent/);
}

function readDelegationReference() {
  return readFileSync(
    join(rootDir, 'source', 'skills', 'polygraph', 'reference', 'delegation.md'),
    'utf8'
  );
}

function sectionBetween(content, start, end) {
  const startIndex = content.indexOf(start);
  assert.notEqual(startIndex, -1);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1);
  return content.slice(startIndex, endIndex);
}

test('polygraph init subagent does not expect candidate repo descriptions', () => {
  const rendered = renderAgent('polygraph-init-subagent');
  const discoverySection = sectionBetween(
    rendered,
    '### Step 1: Discover Candidate Repos',
    '### Step 2: Select Relevant Repos'
  );
  const selectionSection = sectionBetween(
    rendered,
    '### Step 2: Select Relevant Repos',
    '### Step 3: Initialize Polygraph Session or Attach Repos'
  );
  const summarySection = sectionBetween(
    rendered,
    '### Step 5: Return Summary',
    '## Important Notes'
  );

  assert.doesNotMatch(discoverySection, /`description`/);
  assert.match(discoverySection, /Candidate entries do not include repository descriptions/);
  assert.doesNotMatch(selectionSection, /repo descriptions?/);
  assert.doesNotMatch(summarySection, /\| Repo \| Repository ID \| Description \|/);
  assert.match(summarySection, /\| Repo \| Repository ID \| Selected \|/);
});

test('renderArtifact preserves a valid frontmatter boundary for the codex polygraph skill', () => {
  const rendered = renderSkill('polygraph');

  assert.match(rendered, /^---\n[\s\S]*?\n---\n/);
  assert.doesNotMatch(rendered, /\n---#/);
  assert.match(rendered, /\n# Working with Polygraph\b/);
});

test('rendered polygraph skill documents linked references', () => {
  const raw = readFileSync(join(rootDir, 'source', 'skills', 'polygraph', 'SKILL.md'), 'utf8');
  const rendered = renderArtifact(raw, 'codex');

  assert.match(rendered, /`link_reference` \| — \| Link an external reference to a session\./);
  assert.match(rendered, /session\.linkedReferences/);
  assert.match(rendered, /### Linked References/);
  assert.match(rendered, /When an external resource is mentioned during a Polygraph session and appears relevant to the current work/);
  assert.match(rendered, /record it with `link_reference\(\{ sessionId, reference \}\)`/);
  assert.match(rendered, /pull requests, GitHub issues, other Polygraph sessions, and Linear issues/);
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

test('rendered polygraph skill points at the session description reference file', () => {
  const rendered = renderSkill('polygraph');
  const policySection = sectionBetween(
    rendered,
    '### Session Description Policy',
    '### Linked References'
  );
  const publishReference = readFileSync(
    join(rootDir, 'source', 'skills', 'polygraph', 'reference', 'publish-changes.md'),
    'utf8'
  );
  assert.match(rendered, /`update_session` \| `polygraph session update --session <id> \[--title\] \[--description\]`/);
  assert.doesNotMatch(rendered, /update_session_description/);
  assert.doesNotMatch(rendered, /update-description/);

  // The policy section is now a short on-demand pointer to the reference file.
  assert.match(policySection, /`description` is user-facing Polygraph session context/);
  assert.match(policySection, /read \[`reference\/session-description\.md`\]\(reference\/session-description\.md\)/);
  assert.match(policySection, /That reference file holds the full policy/);
  assert.match(publishReference, /[Mm]ust follow the Session Description Policy/);
  assert.match(publishReference, /read \[`session-description\.md`\]\(session-description\.md\)/);
  // The standalone "Update Session Description" subsection folded into the policy section.
  assert.match(policySection, /Use `update_session` directly when the user asks to summarize progress/);
  assert.doesNotMatch(rendered, /### Update Session Description/);

  // The detailed guidance moved OUT of SKILL.md into the reference file.
  assert.doesNotMatch(rendered, /Goal: <what the session is trying to accomplish>/);
  assert.doesNotMatch(rendered, /Next Steps: <clear next implementation steps>/);
  assert.doesNotMatch(rendered, /Prefer high-level state over file-by-file changelogs/);
  assert.doesNotMatch(policySection, /\*\*Parameters:\*\*/);
  assert.doesNotMatch(rendered, /description: "Add user preferences feature: UI in frontend, API in backend"/);
  assert.doesNotMatch(rendered, /Session Description Summary/);
  assert.doesNotMatch(rendered, /cloud_polygraph_create_prs/);
});

test('session description reference ships to every platform dist skill folder', () => {
  const platforms = ['claude', 'opencode', 'codex'];

  for (const platform of platforms) {
    const outputDir = mkdtempSync(join(tmpdir(), `polygraph-${platform}-skills-`));
    processSkills(platform, {
      outputDir,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
    });

    const referencePath = join(
      outputDir,
      'skills',
      'polygraph',
      'reference',
      'session-description.md'
    );
    const reference = readFileSync(referencePath, 'utf8');

    // Canonical template now uses Markdown headings instead of flat labels.
    assert.match(reference, /^## Goal$/m);
    assert.match(reference, /^## Current progress$/m);
    assert.match(reference, /^## What worked$/m);
    assert.match(reference, /^## Next steps$/m);
    assert.doesNotMatch(reference, /^Goal: <what the session is trying to accomplish>$/m);

    // Durable guidance bullets preserved.
    assert.match(reference, /Do not use a one-line feature summary/);
    assert.match(reference, /Keep it concise but durable for a future resumed agent/);
    assert.match(reference, /Prefer high-level state over file-by-file changelogs/);
    assert.match(reference, /Mention unresolved decisions or risks when they matter/);
    assert.match(reference, /include only next implementation steps/);

    // Dual-audience note.
    assert.match(reference, /humans, in the web UI/i);
    assert.match(reference, /reconstructing session history/i);
    assert.match(reference, /Don't assume the original working tree is available/);

    // Formatting building blocks.
    assert.match(reference, /## Formatting building blocks/);
    assert.match(reference, /> \[!WARNING\]/);
    assert.match(reference, /> \[!CAUTION\]/);
    assert.match(reference, /> \[!NOTE\]/);
    assert.match(reference, /> \[!IMPORTANT\]/);
    assert.match(reference, /> \[!TIP\]/);
    assert.match(reference, /Tables \(GFM\)/);
    assert.match(reference, /mermaid/);
    assert.match(reference, /Do NOT redraw the cross-repo dependency \/ repository graph/);
    assert.match(reference, /Plain text remains the norm; diagrams are optional/);
    assert.match(reference, /localhost/);
    assert.match(reference, /file:\/\//);
    assert.match(reference, /Do NOT put repo-relative file paths/);
    assert.match(reference, /use the `link_reference` tool instead of inline links/);
    assert.match(reference, /\*\*supplementary\*\* to the description, not a replacement/);
  }
});

test('publish changes reference ships to every platform dist skill folder', () => {
  const platforms = ['claude', 'opencode', 'codex'];

  for (const platform of platforms) {
    const outputDir = mkdtempSync(join(tmpdir(), `polygraph-${platform}-skills-`));
    processSkills(platform, {
      outputDir,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
    });

    const referencePath = join(
      outputDir,
      'skills',
      'polygraph',
      'reference',
      'publish-changes.md'
    );
    const reference = readFileSync(referencePath, 'utf8');

    // The full branch-to-PR flow lives in the reference file.
    assert.match(reference, /^## Push Branches$/m);
    assert.match(reference, /^## Create Draft PRs$/m);
    assert.match(reference, /^## Mark PRs Ready$/m);
    assert.match(reference, /^## Associate Existing PRs$/m);
    assert.match(reference, /pushes from the local checkout/);
    assert.match(reference, /PR titles become squash-merge commit messages/);
    assert.match(reference, /transition PRs from DRAFT to OPEN status/);
    assert.match(reference, /prUrls/);

    // The skill keeps only a short on-demand pointer to the reference file.
    const rendered = renderSkill('polygraph', platform);
    assert.match(rendered, /### Publish Changes \(Push Branches, Create PRs, Mark Ready\)/);
    assert.match(rendered, /read \[`reference\/publish-changes\.md`\]\(reference\/publish-changes\.md\)/);
    assert.doesNotMatch(rendered, /^### \d+\. Push Branches$/m);
    assert.doesNotMatch(rendered, /^### \d+\. Create Draft PRs$/m);
    assert.doesNotMatch(rendered, /^### \d+\. Mark PRs Ready$/m);
    assert.doesNotMatch(rendered, /^### \d+\. Associate Existing PRs$/m);
    assert.doesNotMatch(rendered, /PR titles become squash-merge commit messages/);
    assert.doesNotMatch(rendered, /prUrls/);
    assert.doesNotMatch(rendered, /polygraph\/ad5fa-add-user-preferences/);
  }
});

test('codex polygraph skill uses custom Codex subagent guidance', () => {
  const rendered = renderSkill('polygraph');

  assert.match(rendered, /agent_type: "polygraph-init-subagent"/);
  assert.match(rendered, /agent_type: "polygraph-delegate-subagent"/);
  assert.match(rendered, /Codex `spawn_agent` ≠ Polygraph MCP `spawn_agent`/);
  assert.match(rendered, /`wait_agent`/);
  assert.match(rendered, /stop session work/i);
  assert.match(rendered, /Re-run `polygraph whoami`/);
  assert.match(rendered, /parent conversation is responsible for detecting an existing session ID/);
  assert.match(rendered, /fresh Codex Desktop conversation started with `\/polygraph:session-start`/);
  assert.match(rendered, /Resume is not a work command/);
  assert.match(rendered, /Treat "resume" as context restoration followed by waiting for user instructions/);
  assert.doesNotMatch(rendered, /- target: "<org\/repo-name>"/);
  assert.doesNotMatch(rendered, /target: "org\/repo-name"/);
  // The spawn_agent call shape moved to reference/delegation.md. The parameter
  // is `repo`, never `target`.
  const delegationReference = readFileSync(
    join(rootDir, 'source', 'skills', 'polygraph', 'reference', 'delegation.md'),
    'utf8'
  );
  assert.match(delegationReference, /repo: "<org\/repo-name>"/);
  assert.doesNotMatch(delegationReference, /target: "<org\/repo-name>"/);
  const publishReference = readFileSync(
    join(rootDir, 'source', 'skills', 'polygraph', 'reference', 'publish-changes.md'),
    'utf8'
  );
  assert.match(publishReference, /repo: "org\/repo-name"/);
  assert.doesNotMatch(publishReference, /target: "org\/repo-name"/);
  assertNoNonCodexDelegationText(rendered);
});

test('codex session-start skill routes session creation through init subagent', () => {
  const rendered = renderSkill('session-start');

  assert.match(rendered, /^---\n[\s\S]*?name: session-start[\s\S]*?\n---\n/);
  assert.match(rendered, /Start or reconnect a Polygraph session/);
  assert.match(rendered, /Check Authentication First/);
  assert.match(rendered, /If auth is missing, expired, or no organization is selected, stop session work/);
  assert.match(rendered, /Facilitate user reauth through the browser-based flow/);
  assert.match(rendered, /Re-run `whoami` after reauth/);
  assert.match(rendered, /Parent Session Detection/);
  assert.match(rendered, /parent conversation is responsible for detecting an existing Polygraph session ID/);
  assert.match(rendered, /init subagent cannot infer the parent's current session context by itself/);
  assert.match(rendered, /fresh Codex Desktop conversation started with `\/polygraph:session-start`/);
  assert.match(rendered, /agent_type: "polygraph-init-subagent"/);
  assert.match(rendered, /Do NOT call the Polygraph MCP `list_repos` or `start_session` tools directly/);
  assert.match(rendered, /Direct `add_repo` is allowed only when the user gives exact repository refs/);
  assert.match(rendered, /If sessionId is provided, reuse that session and use add_repo/);
  assert.match(rendered, /The parent conversation detected any existing sessionId/);
  assert.match(rendered, /this is a fresh session-start flow; create a new session via start_session/);
  assert.match(rendered, /If exact repo refs were provided, pass them directly to add_repo and do NOT call list_repos/);
  assert.match(rendered, /Collect the result with `wait_agent`/);
  assert.match(rendered, /`session_intro` MCP tool/);
  assertNoNonCodexDelegationText(rendered);
});

test('rendered polygraph skill keeps session intro as hidden internal fallback', () => {
  const rendered = renderSkill('polygraph');
  const toolsSection = sectionBetween(rendered, '## Available Tools', '## CLI Statefulness');

  assert.match(rendered, /`session_intro` MCP tool/);
  assert.match(rendered, /`polygraph session intro -s <sessionId>`/);
  assert.match(rendered, /hidden `polygraph session intro -s <sessionId>`/);
  assert.doesNotMatch(toolsSection, /polygraph session intro/);
});

test('publish changes reference documents PR repository semantics', () => {
  const publishReference = readFileSync(
    join(rootDir, 'source', 'skills', 'polygraph', 'reference', 'publish-changes.md'),
    'utf8'
  );
  const createPrSection = sectionBetween(
    publishReference,
    '## Create Draft PRs',
    '## Mark PRs Ready'
  );
  const associateStart = publishReference.indexOf('## Associate Existing PRs');
  assert.notEqual(associateStart, -1);
  const associatePrSection = publishReference.slice(associateStart);

  assert.match(createPrSection, /`targetRepository` \(optional\): Target GitHub repository for fork PR creation or registration/);
  assert.match(createPrSection, /keep `owner` and `repo` set to the source repository/);
  assert.match(createPrSection, /targetRepository: "org\/frontend"/);

  assert.match(associatePrSection, /Provide either a `prUrl` to associate a specific PR, or a `branch` name plus `repo` to find and associate PRs for a source repository\./);
  assert.match(associatePrSection, /- `repo` \(optional\): Source repository for branch-based association/);
  assert.match(associatePrSection, /repo: "org\/repo"/);
  assert.doesNotMatch(associatePrSection, /URL-based association infers|Branch-based association uses/);
  assert.doesNotMatch(associatePrSection, /targetRepo|targetRepository/);
});

test('polygraph skill points to the sandboxing reference and stays platform-clean', () => {
  const claude = renderSkill('polygraph', 'claude');
  const codex = renderSkill('polygraph', 'codex');
  const opencode = renderSkill('polygraph', 'opencode');

  // Claude/Codex keep the recognize-and-stop rule and a pointer inline; the detailed
  // per-harness remediation moved to reference/sandboxing.md.
  for (const rendered of [claude, codex]) {
    assert.match(rendered, /## Sandboxing in Polygraph Sessions/);
    assert.match(rendered, /`!`-prefixed user commands \(those run in the same sandbox\)/);
    assert.match(rendered, /\[`reference\/sandboxing\.md`\]\(reference\/sandboxing\.md\)/);
    assert.match(rendered, /Never conclude the repo, tool, or framework is broken/);
    assert.doesNotMatch(rendered, /\{%|\{\{/);
    // detailed snippets no longer live in the skill body
    assert.doesNotMatch(rendered, /\.claude\/settings\.json/);
    assert.doesNotMatch(rendered, /\.codex\/config\.toml/);
    assert.doesNotMatch(rendered, /sandbox_workspace_write/);
  }

  // OpenCode is not sandboxed: no sandboxing section or pointer in its skill.
  assert.doesNotMatch(opencode, /sandbox/i);

  // The full policy — both harness variants — lives in the reference file, verbatim (no liquid).
  const sandboxingReference = readFileSync(
    join(rootDir, 'source', 'skills', 'polygraph', 'reference', 'sandboxing.md'),
    'utf8'
  );
  assert.doesNotMatch(sandboxingReference, /\{%|\{\{/);
  assert.match(sandboxingReference, /Recognize sandbox denials — do not retry or work around them\./);
  assert.match(sandboxingReference, /Never blame the tooling\./);
  assert.match(sandboxingReference, /\.claude\/settings\.json/);
  assert.match(sandboxingReference, /"allowWrite"/);
  assert.match(sandboxingReference, /agentOptions\.claude\.sandbox: false/);
  assert.match(sandboxingReference, /\.codex\/config\.toml/);
  assert.match(sandboxingReference, /\[sandbox_workspace_write\]/);
  assert.match(sandboxingReference, /network_access = true/);
  assert.match(sandboxingReference, /agentOptions\.codex\.sandbox: false/);
});

test('codex CI skills include built-in subagent guidance', () => {
  const getLatestCi = renderSkill('get-latest-ci');
  const awaitPolygraphCi = renderSkill('await-polygraph-ci');

  assert.match(getLatestCi, /Use a Codex built-in subagent to call the MCP tool/);
  assert.match(getLatestCi, /Always delegate the MCP call to a Codex built-in subagent/);
  assert.match(getLatestCi, /`wait_agent`/);

  assert.match(awaitPolygraphCi, /Codex subagent wrapper/);
  assert.match(awaitPolygraphCi, /agent_type: "polygraph-delegate-subagent"/);
  assert.match(awaitPolygraphCi, /the waiting runs inside `polygraph-delegate-subagent`/);
  assert.match(awaitPolygraphCi, /show_agent\(sessionId: "<session-id>", id: "<delegation-id>"\)/);
  assert.doesNotMatch(awaitPolygraphCi, /show_agent\(sessionId: "<session-id>", target: "frontend"\)/);
  // The old instruction to pull log tails while polling must stay gone.
  assert.doesNotMatch(awaitPolygraphCi, /Use the `tail` parameter to retrieve recent output lines/);
  assert.match(awaitPolygraphCi, /`wait_agent`/);

  assertNoNonCodexDelegationText(getLatestCi);
  assertNoNonCodexDelegationText(awaitPolygraphCi);
});

test('adversarial-review skill presents and attaches one dedicated review artifact', () => {
  const claude = renderSkill('adversarial-review', 'claude');
  const codex = renderSkill('adversarial-review', 'codex');
  const opencode = renderSkill('adversarial-review', 'opencode');

  for (const rendered of [claude, codex, opencode]) {
    assert.match(rendered, /^---\n[\s\S]*?name: adversarial-review[\s\S]*?\n---\n/);
    assert.match(rendered, /^description: Review a Polygraph session with independent per-repo reviewers and attach one consolidated review artifact\./m);
    assert.doesNotMatch(rendered, /\{%|\{\{/);

    // Density guard: the user's numbered steps and nothing else. Several
    // rounds of elaboration grew this back; keep it pinned.
    // Measured on the body, so the claude allowed-tools block does not count.
    const body = rendered.replace(/^---\n[\s\S]*?\n---\n/, '');
    assert.ok(body.split(/\s+/).filter(Boolean).length < 200);

    // Steps 1-6 are bolded and in order; step 7 is not bolded.
    assert.deepEqual(rendered.match(/^\d\. \*\*[^*]+\*\*/gm), [
      '1. **Pick the agent.**',
      '2. **Get the session description.**',
      '3. **Get each repo\'s plan.**',
      '4. **Delegate one reviewer per repo**',
      '5. **Summarize and attach.**',
      '6. **Ask what next.**',
    ]);
    assert.match(rendered, /^7\. If the user selects "address the feedback"/m);
    assert.deepEqual(rendered.match(/^#+ .*/gm), ['# Adversarial Review']);

    // Tool names and parameters needed to execute the steps.
    assert.match(rendered, /`claude`, `codex`, or `opencode` for `spawn_agent`'s `agent` parameter/);
    assert.match(rendered, /`role: "reviewer"`/);
    assert.match(rendered, /one consolidated Markdown review with per-repo sections/);
    assert.match(rendered, /present it to the user\. Then call `upload_artifact` once/);
    assert.match(rendered, /`sessionId`/);
    assert.match(rendered, /that review as `content`/);
    assert.match(rendered, /`kind: "review"`/);
    assert.match(rendered, /`format: "markdown"`/);
    assert.match(rendered, /`adversarial-review-YYYY-MM-DDTHH-mm-ssZ\.md`/);
    assert.match(rendered, /If the upload fails, report that separately without suppressing the review\./);
    assert.doesNotMatch(rendered, /upload the summary/);

    // Both skip conditions.
    assert.match(rendered, /Skip if the user already named one\./);
    assert.match(rendered, /Skip if the user already said\./);

    // The initiator repo is reviewed by a delegated reviewer like any other,
    // but fixes route to each repo's default agent and the initiator fixes
    // itself. A future edit must not silently flip these back.
    assert.match(rendered, /Do the delegation even for the "initiator" repo\./);
    assert.match(rendered, /pass each repo's feedback to the repo default agent \(not the reviewer\)/);
    assert.match(rendered, /The initiator should fix things itself without delegating\./);
  }

  // The claude frontmatter block is the only platform gating left.
  assert.match(claude, /\nuser-invocable: true\n/);
  assert.match(claude, /- AskUserQuestion\n/);
  assert.doesNotMatch(opencode, /user-invocable/);
  assert.doesNotMatch(codex, /user-invocable/);
  assertNoNonCodexDelegationText(codex);
});

// The own-repo rule moved out of the (now id-only) subagent prompt and into the
// delegation reference, which is where the spawning contract lives.
test('delegation own-repo rule is scoped to the default role', () => {
  const reference = readDelegationReference();
  assert.match(
    reference,
    /With the default role, `repo` must be a repository other than the one you are working in — never delegate into your own repo with the default role/
  );
  assert.match(
    reference,
    /Delegating into your own repo IS allowed with an explicit non-default `role`/
  );

  for (const platform of ['claude', 'codex', 'opencode']) {
    const skill = renderSkill('polygraph', platform);
    assert.match(
      skill,
      /With the default role, delegate only to \*other\* repos — never to the repo you are in/
    );
    assert.match(
      skill,
      /Delegating into the repo you are in is allowed only with an explicit non-default `role`\./
    );
  }
});

// Ocean's polygraph-native-subagents.ts parses `**Repo:**` out of the exit
// message to join a finished delegation back to its child agent. The field
// labels are a cross-repo contract, not cosmetic formatting.
test('delegate subagent pins the exit message shape', () => {
  for (const platform of ['claude', 'codex', 'opencode']) {
    const agent = renderAgent('polygraph-delegate-subagent', platform);

    assert.match(agent, /^Child agent <id> is done\.$/m);
    assert.match(agent, /^\*\*Repo:\*\* <repoFullName>$/m);
    assert.match(agent, /^\*\*Delegation id:\*\* <id>$/m);
    assert.match(agent, /^\*\*Status:\*\* <status>$/m);
    assert.match(agent, /^Read the result with show_agent \(id: "<id>"\)\.$/m);
    assert.match(agent, /replace "is done\." with "needs attention\."/);

    // The verbose summary the poller used to build is gone — it echoed the
    // child's output back through a second context for no reason.
    assert.doesNotMatch(agent, /## Polygraph Delegation Result/);
    assert.doesNotMatch(agent, /### Result/);
    assert.doesNotMatch(agent, /### Suggestions/);
  }
});

// The poller is a doorbell, not a reporter: one tool, one argument shape, no
// log fetching, no summarizing. This is what keeps multi-repo runs cheap.
test('delegate subagent polling contract keeps status polls cheap', () => {
  for (const platform of ['claude', 'codex', 'opencode']) {
    const agent = renderAgent('polygraph-delegate-subagent', platform);

    assert.match(agent, /`waitForTransitionMs`: 300000/);
    assert.doesNotMatch(agent, /50000/);
    assert.match(agent, /Each call blocks up to 5 minutes/);

    // Addressed by delegation id, never by repo + role.
    assert.match(agent, /The delegation id returned by `spawn_agent`/);
    assert.match(agent, /`children\[0\]`/);

    // It cannot fetch logs, and must not narrate the child's work.
    assert.match(
      agent,
      /Never pass `tail`\. Apart from the CLI fallback above, never call any other tool, and never read files, transcripts, or logs\./
    );
    assert.match(agent, /you never fetch logs/);
    assert.match(agent, /Do not summarize, quote, or describe the child's work/);

    // Spawning, stopping, and log paging are the main agent's job now.
    assert.doesNotMatch(agent, /stop_agent/);
    assert.doesNotMatch(agent, /lastOutputLines/);
    assert.doesNotMatch(agent, /inputRequiredQuestion/);
  }
});

// One status call plus a shell to run its CLI equivalent. Withholding
// everything else is what makes "never read logs" enforceable rather than
// advisory.
test('delegate subagent is granted only show_agent and a shell', () => {
  const claude = renderAgent('polygraph-delegate-subagent', 'claude');
  const frontmatter = claude.match(/^---\n([\s\S]*?)\n---/)[1];

  assert.match(frontmatter, /^name: polygraph-delegate-subagent$/m);
  assert.match(frontmatter, /^model: haiku$/m);
  assert.match(frontmatter, /^tools:$/m);
  assert.match(frontmatter, /mcp__plugin_polygraph_polygraph-mcp__show_agent/);
  assert.match(frontmatter, /^\s*-\s*Bash\s*$/m);
  assert.match(frontmatter, /description: Waits for one Polygraph child agent/);

  // Exactly those two entries — no spawning, stopping, or log paging.
  assert.equal((frontmatter.match(/^\s*-\s+\S+$/gm) || []).length, 2);
  assert.doesNotMatch(frontmatter, /spawn_agent/);
  assert.doesNotMatch(frontmatter, /stop_agent/);
});

// The MCP server can be uninstalled, or still be starting up when a spawned
// subagent takes its first turn — in which case show_agent is simply absent
// from the tool list. The CLI is the same call by another route.
test('delegate subagent falls back to the polygraph CLI', () => {
  for (const platform of ['claude', 'codex', 'opencode']) {
    const agent = renderAgent('polygraph-delegate-subagent', platform);

    assert.match(
      agent,
      /polygraph agent show --session <sessionId> --id <id> --wait-for-transition-ms 300000/
    );
    assert.match(agent, /Prefer the MCP tool/);
    assert.match(agent, /Check your available tools before the first poll/);
    assert.match(agent, /use the CLI for the rest of the loop and do not switch back/);
  }
});

test('delegation reference ships to every platform dist skill folder', () => {
  for (const platform of ['claude', 'opencode', 'codex']) {
    const outputDir = mkdtempSync(join(tmpdir(), `polygraph-${platform}-skills-`));
    processSkills(platform, {
      outputDir,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
    });

    const reference = readFileSync(
      join(outputDir, 'skills', 'polygraph', 'reference', 'delegation.md'),
      'utf8'
    );

    // Reference files are copied verbatim, so they must carry no liquid.
    assert.doesNotMatch(reference, /\{%|\{\{/);

    // The pointer-based contract lives here in full.
    assert.match(reference, /^## The delegation id$/m);
    assert.match(reference, /^## Spawning$/m);
    assert.match(reference, /^## Waiting$/m);
    assert.match(reference, /^## Reading the result$/m);
    assert.match(reference, /^## Follow-ups$/m);
    assert.match(reference, /^## Roles$/m);
    assert.match(reference, /^## Stopping$/m);
    assert.match(reference, /Call `spawn_agent` directly from the main conversation/);
    assert.match(reference, /`result\.text` is the child's final message/);
    assert.match(reference, /returns a \*\*new\*\* delegation id/);
    assert.match(reference, /Routine polling never happens in the main conversation/);
    assert.match(reference, /never `cd` into them/);
    assert.match(reference, /Restoring is read-only/);
    assert.match(reference, /description `Delegate to <repo>`/);

    // The skill keeps only the required-reading pointer.
    const rendered = renderSkill('polygraph', platform);
    assert.match(
      rendered,
      /Read \[`reference\/delegation\.md`\]\(reference\/delegation\.md\) first — required\./
    );
    assert.match(rendered, /burns tokens or breaks session tracking/);

    // The moved doctrine must not be duplicated back into the skill.
    assert.doesNotMatch(rendered, /## Simple tasks \(fire-and-forget\)/);
    assert.doesNotMatch(rendered, /## Multi-turn tasks \(interactive\)/);
    assert.doesNotMatch(rendered, /## Agent roles/);
  }
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
  assert.match(delegateAgent.description, /Waits for one Polygraph child agent/);
  assert.match(delegateAgent.developer_instructions, /# Polygraph Delegate Subagent/);
  assert.match(delegateAgent.developer_instructions, /^## Loop$/m);
  assert.match(delegateAgent.developer_instructions, /`waitForTransitionMs`: 300000/);
  assert.doesNotMatch(delegateAgent.developer_instructions, /waitForTransitionMs: 50000/);
  assert.doesNotMatch(delegateAgent.developer_instructions, /backoff/i);
  assert.doesNotMatch(delegateAgent.developer_instructions, /sleep/i);
  assert.match(
    delegateAgent.developer_instructions,
    /polygraph agent show --session <sessionId> --id <id> --wait-for-transition-ms 300000/
  );

  // Resume-is-read-only doctrine moved to the delegation reference along with
  // the rest of the spawning contract.
  const reference = readDelegationReference();
  assert.match(reference, /Restoring is read-only/);
  assert.match(
    reference,
    /do not continue the prior work or make further changes until the user explicitly asks for them/
  );
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

  assert.match(delegateAgent, /^---\n\s*description: Waits for one Polygraph child agent/);
  assert.match(delegateAgent, /\nmode: subagent\n\s*---\n/);
  assert.match(delegateAgent, /# Polygraph Delegate Subagent/);
  assert.doesNotMatch(delegateAgent, /^developer_instructions = /m);
  // OpenCode gets no `tools:` list, so the tool guarantee is Claude-side.
  assert.doesNotMatch(delegateAgent, /^tools:$/m);
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

test('codex plugin manifest describes Polygraph beyond multi-repo coordination', () => {
  const manifest = buildCodexPluginManifest(readRootPackageJson());

  assert.equal(
    manifest.interface.shortDescription,
    'Cross-repo visibility and persistent memory for Codex agents.'
  );
  assert.equal(
    manifest.interface.longDescription,
    'Give Codex the Polygraph meta-harness: repository graph context, resumable agent sessions, linked PR and CI state, and workflows for coordinating work across repo boundaries when needed.'
  );
  assert.deepEqual(manifest.interface.defaultPrompt, [
    'Start a Polygraph session for this work.',
    'Start a Polygraph session and include the repos related to this change.',
    'Resume or inspect my Polygraph session and summarize the current state.',
  ]);
});

test('opencode package is published as a native plugin package', () => {
  const pkg = buildOpenCodePackageJson(readRootPackageJson());

  assert.equal(pkg.name, '@polygraph/opencode-plugin');
  assert.equal(pkg.private, false);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.exports, { './server': './server.js' });
  assert.equal(pkg.main, './server.js');
  assert.deepEqual(pkg.dependencies, { 'js-yaml': '^4.1.1' });
  assert.deepEqual(pkg.files, ['server.js', 'agent-session-link.mjs', 'skills/', 'agents/', 'README.md']);
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

test('buildMcpConfig can force an MCP server agent type', () => {
  assert.deepEqual(buildMcpConfig('codex'), {
    mcpServers: {
      'polygraph-mcp': {
        type: 'stdio',
        command: 'npx',
        args: ['@polygraph/mcp@latest'],
        env: {
          POLYGRAPH_AGENT_TYPE: 'codex',
        },
      },
    },
  });
});
