import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  collectTokenCostEntries,
  countCharacters,
  estimateTokens,
  parseCliArgs,
  renderTokenCostReport,
} from '../scripts/report-token-costs.mjs';
import {
  createPlatformConfigs,
  renderArtifact,
} from '../scripts/src/sync-artifacts/common.mjs';
import {
  processAgents,
  processSkills,
  renderCodexAgentToml,
} from '../scripts/src/sync-artifacts/processors.mjs';

test('counts Unicode characters and rounds token estimates up', () => {
  assert.equal(countCharacters('four\n'), 5);
  assert.equal(countCharacters('🚀'), 1);
  assert.equal(estimateTokens(5, 4), 2);
  assert.equal(estimateTokens(8, 4), 2);
});

test('lists polygraph references immediately after the main skill', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'polygraph-token-costs-'));

  try {
    writeFixture(rootDir, 'source/skills/alpha/SKILL.md', 'alpha');
    writeFixture(rootDir, 'source/skills/polygraph/SKILL.md', 'polygraph');
    writeFixture(
      rootDir,
      'source/skills/polygraph/reference/z-last.md',
      'last'
    );
    writeFixture(
      rootDir,
      'source/skills/polygraph/reference/a-first.md',
      'first'
    );
    writeFixture(rootDir, 'source/skills/zeta/SKILL.md', 'zeta');
    writeFixture(rootDir, 'source/agents/worker/AGENT.md', 'worker');

    const entries = collectTokenCostEntries({
      rootDir,
      platforms: ['claude'],
    });

    assert.deepEqual(
      entries.map(({ platform, kind, name }) => [platform, kind, name]),
      [
        ['claude', 'Skill', 'alpha'],
        ['claude', 'Skill', 'polygraph'],
        ['claude', 'Reference', '↳ polygraph/reference/a-first.md'],
        ['claude', 'Reference', '↳ polygraph/reference/z-last.md'],
        ['claude', 'Skill', 'zeta'],
        ['claude', 'Subagent', 'worker'],
      ]
    );
    assert.deepEqual(
      entries.map(({ characters, estimatedTokens }) => [
        characters,
        estimatedTokens,
      ]),
      [
        [5, 2],
        [9, 3],
        [5, 2],
        [4, 1],
        [4, 1],
        [6, 2],
      ]
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('measures the same compiled content produced for each agent', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'polygraph-compiled-costs-'));
  const skill = [
    '---',
    'name: conditional',
    'description: Conditional skill',
    '---',
    '{% if platform == "claude" %}Claude only{% elsif platform == "codex" %}Codex only{% else %}OpenCode only{% endif %}',
    '',
  ].join('\n');
  const agent = [
    '---',
    'description: Conditional agent',
    '---',
    '{% if platform == "claude" %}Claude agent{% elsif platform == "codex" %}Codex agent{% else %}OpenCode agent{% endif %}',
    '',
  ].join('\n');

  try {
    writeFixture(rootDir, 'source/skills/conditional/SKILL.md', skill);
    writeFixture(rootDir, 'source/agents/conditional/AGENT.md', agent);

    const entries = collectTokenCostEntries({ rootDir });

    for (const platform of ['claude', 'codex', 'opencode']) {
      const skillEntry = entries.find(
        (entry) =>
          entry.platform === platform &&
          entry.kind === 'Skill' &&
          entry.name === 'conditional'
      );
      const agentEntry = entries.find(
        (entry) =>
          entry.platform === platform &&
          entry.kind === 'Subagent' &&
          entry.name === 'conditional'
      );
      const compiledAgent =
        platform === 'codex'
          ? renderCodexAgentToml('conditional', agent, platform)
          : renderArtifact(agent, platform);

      assert.equal(
        skillEntry.characters,
        countCharacters(renderArtifact(skill, platform))
      );
      assert.equal(agentEntry.characters, countCharacters(compiledAgent));
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('every report row matches the corresponding built artifact', () => {
  const rootDir = resolve(import.meta.dirname, '..');
  const outputRoot = mkdtempSync(join(tmpdir(), 'polygraph-report-dist-'));
  const configs = createPlatformConfigs();

  try {
    for (const platform of ['claude', 'codex', 'opencode']) {
      const outputDir = join(outputRoot, platform);
      const config = { ...configs[platform], outputDir };
      processSkills(platform, config);
      processAgents(platform, config);

      const entries = collectTokenCostEntries({
        rootDir,
        platforms: [platform],
      });
      for (const entry of entries) {
        const artifactPath =
          entry.kind === 'Subagent'
            ? join(
                outputDir,
                config.agentsDir,
                `${entry.name}${config.agentsExt}`
              )
            : join(
                outputDir,
                entry.path.replace(/^source\/skills\//, 'skills/')
              );

        assert.equal(
          entry.characters,
          countCharacters(readFileSync(artifactPath, 'utf8')),
          `${platform}:${entry.name}`
        );
      }
    }
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('renders a Markdown report with totals and the estimation ratio', () => {
  const report = renderTokenCostReport(
    [
      {
        platform: 'claude',
        kind: 'Skill',
        name: 'polygraph',
        characters: 1234,
        estimatedTokens: 309,
      },
      {
        platform: 'codex',
        kind: 'Skill',
        name: 'polygraph',
        characters: 1200,
        estimatedTokens: 300,
      },
      {
        platform: 'opencode',
        kind: 'Skill',
        name: 'polygraph',
        characters: 1000,
        estimatedTokens: 250,
      },
      {
        platform: 'claude',
        kind: 'Subagent',
        name: 'worker',
        characters: 10,
        estimatedTokens: 3,
      },
      {
        platform: 'codex',
        kind: 'Subagent',
        name: 'worker',
        characters: 8,
        estimatedTokens: 2,
      },
      {
        platform: 'opencode',
        kind: 'Subagent',
        name: 'worker',
        characters: 4,
        estimatedTokens: 1,
      },
    ],
    4
  );

  assert.match(report, /Estimated at 1 token per 4 compiled characters/);
  assert.match(
    report,
    /\| Kind \| Skill \/ subagent \| Claude Code \| Codex \| OpenCode \|/
  );
  assert.match(report, /\| Skill \| polygraph \| 309 \| 300 \| 250 \|/);
  assert.match(
    report,
    /\| \*\*Total\*\* \| \*\*2 files\*\* \| \*\*312\*\* \| \*\*302\*\* \| \*\*251\*\* \|/
  );
  assert.doesNotMatch(report, /\| Characters \|/);
});

test('escapes generated names before placing them in the Markdown table', () => {
  const report = renderTokenCostReport([
    {
      platform: 'claude',
      kind: 'Skill',
      name: 'unsafe|@mention\n<img>',
      characters: 4,
      estimatedTokens: 1,
    },
  ]);

  assert.match(report, /unsafe\\\|&#64;mention &lt;img&gt;/);
  assert.doesNotMatch(report, /<img>/);
});

test('parses a configurable characters-per-token ratio', () => {
  assert.deepEqual(parseCliArgs([]), {
    charactersPerToken: 4,
    rootDir: resolve(import.meta.dirname, '..'),
    help: false,
  });
  assert.deepEqual(
    parseCliArgs([
      '--characters-per-token',
      '3.5',
      '--root-dir',
      'fixture',
    ]),
    {
      charactersPerToken: 3.5,
      rootDir: resolve('fixture'),
      help: false,
    }
  );
  assert.throws(
    () => parseCliArgs(['--characters-per-token=0']),
    /positive number/
  );
  assert.throws(() => parseCliArgs(['--unknown']), /Unknown argument/);
  assert.throws(() => parseCliArgs(['--root-dir']), /requires a path/);
  assert.throws(() => parseCliArgs(['--root-dir=']), /requires a path/);
});

function writeFixture(rootDir, relativePath, content) {
  const path = join(rootDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
