import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
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

    const entries = collectTokenCostEntries({ rootDir });

    assert.deepEqual(
      entries.map(({ kind, name }) => [kind, name]),
      [
        ['Skill', 'alpha'],
        ['Skill', 'polygraph'],
        ['Reference', '↳ polygraph/reference/a-first.md'],
        ['Reference', '↳ polygraph/reference/z-last.md'],
        ['Skill', 'zeta'],
        ['Subagent', 'worker'],
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

test('renders a Markdown report with totals and the estimation ratio', () => {
  const report = renderTokenCostReport(
    [
      {
        kind: 'Skill',
        name: 'polygraph',
        characters: 1234,
        estimatedTokens: 309,
      },
      {
        kind: 'Subagent',
        name: 'worker',
        characters: 10,
        estimatedTokens: 3,
      },
    ],
    4
  );

  assert.match(report, /1 estimated token per 4 characters/);
  assert.match(report, /\| Skill \| polygraph \| 1,234 \| 309 \|/);
  assert.match(
    report,
    /\| \*\*Total\*\* \| \*\*2 files\*\* \| \*\*1,244\*\* \| \*\*312\*\* \|/
  );
});

test('escapes generated names before placing them in the Markdown table', () => {
  const report = renderTokenCostReport([
    {
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
