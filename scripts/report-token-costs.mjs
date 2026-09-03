import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderArtifact } from './src/sync-artifacts/common.mjs';
import { renderCodexAgentToml } from './src/sync-artifacts/processors.mjs';

const projectRoot = join(import.meta.dirname, '..');

export const DEFAULT_CHARACTERS_PER_TOKEN = 4;
export const SUPPORTED_PLATFORMS = ['claude', 'codex', 'opencode'];

export function countCharacters(content) {
  return [...content].length;
}

export function estimateTokens(characterCount, charactersPerToken) {
  validateCharactersPerToken(charactersPerToken);
  return Math.ceil(characterCount / charactersPerToken);
}

export function collectTokenCostEntries({
  rootDir = projectRoot,
  charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN,
  platforms = SUPPORTED_PLATFORMS,
} = {}) {
  validateCharactersPerToken(charactersPerToken);
  validatePlatforms(platforms);

  const sourceDir = join(rootDir, 'source');
  if (!existsSync(sourceDir)) {
    throw new Error(`source directory not found under ${rootDir}`);
  }

  const skillsDir = join(sourceDir, 'skills');
  const agentsDir = join(sourceDir, 'agents');
  const entries = [];

  for (const platform of platforms) {
    for (const skillName of listDirectories(skillsDir)) {
      const skillPath = join(skillsDir, skillName, 'SKILL.md');
      if (!isRegularFile(skillPath)) continue;

      const raw = readFileSync(skillPath, 'utf8');
      entries.push(
        createEntry({
          platform,
          kind: 'Skill',
          name: skillName,
          sourcePath: skillPath,
          rootDir,
          content: renderArtifact(raw, platform),
          charactersPerToken,
        })
      );

      if (skillName === 'polygraph') {
        const referenceDir = join(skillsDir, skillName, 'reference');
        for (const referencePath of listMarkdownFiles(referenceDir)) {
          const referenceName = toPosixPath(
            relative(join(skillsDir, skillName), referencePath)
          );
          entries.push(
            createEntry({
              platform,
              kind: 'Reference',
              name: `↳ ${skillName}/${referenceName}`,
              sourcePath: referencePath,
              rootDir,
              content: readFileSync(referencePath, 'utf8'),
              charactersPerToken,
            })
          );
        }
      }
    }

    for (const agentName of listDirectories(agentsDir)) {
      const agentPath = join(agentsDir, agentName, 'AGENT.md');
      if (!isRegularFile(agentPath)) continue;

      const raw = readFileSync(agentPath, 'utf8');
      const content =
        platform === 'codex'
          ? renderCodexAgentToml(agentName, raw, platform)
          : renderArtifact(raw, platform);
      entries.push(
        createEntry({
          platform,
          kind: 'Subagent',
          name: agentName,
          sourcePath: agentPath,
          rootDir,
          content,
          charactersPerToken,
        })
      );
    }
  }

  return entries;
}

export function renderTokenCostReport(
  entries,
  charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN,
  baselineEntries
) {
  validateCharactersPerToken(charactersPerToken);

  const rowsByKey = groupEntries(entries);
  const currentRowCount = rowsByKey.size;
  const baselineRowsByKey =
    baselineEntries === undefined ? undefined : groupEntries(baselineEntries);

  if (baselineRowsByKey) {
    for (const [key, row] of baselineRowsByKey) {
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, { kind: row.kind, name: row.name, tokens: {} });
      }
    }
  }

  const rows = [...rowsByKey.values()].map(
    (row) => {
      const key = `${row.kind}\0${row.name}`;
      const baselineTokens = baselineRowsByKey?.get(key)?.tokens;
      const deltaCell = baselineRowsByKey
        ? ` | ${formatTokenDeltas(row.tokens, baselineTokens)}`
        : '';

      return `| ${row.kind} | ${escapeMarkdownTableCell(row.name)} | ${formatTokens(row.tokens.claude)} | ${formatTokens(row.tokens.codex)} | ${formatTokens(row.tokens.opencode)}${deltaCell} |`;
    }
  );
  const totals = calculateTotals(entries);
  const baselineTotals = baselineEntries
    ? calculateTotals(baselineEntries)
    : undefined;
  const deltaHeader = baselineRowsByKey
    ? ' | Δ vs main<br>Claude / Codex / OpenCode'
    : '';
  const deltaAlignment = baselineRowsByKey ? ' | ---:' : '';
  const totalDeltaCell = baselineTotals
    ? ` | **${formatTokenDeltas(totals, baselineTotals)}**`
    : '';

  return [
    '# Estimated compiled token costs',
    '',
    `Estimated at 1 token per ${formatNumber(charactersPerToken)} compiled characters, rounded up per file.`,
    '',
    `| Kind | Skill / subagent | Claude Code | Codex | OpenCode${deltaHeader} |`,
    `| --- | --- | ---: | ---: | ---:${deltaAlignment} |`,
    ...rows,
    `| **Total** | **${formatNumber(currentRowCount)} files** | **${formatTokens(totals.claude)}** | **${formatTokens(totals.codex)}** | **${formatTokens(totals.opencode)}**${totalDeltaCell} |`,
    '',
  ].join('\n');
}

export function parseCliArgs(args) {
  let charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN;
  let rootDir = projectRoot;
  let baselineRootDir;
  let help = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }

    if (argument === '--characters-per-token') {
      const value = args[++index];
      if (value === undefined) {
        throw new Error('--characters-per-token requires a number');
      }
      charactersPerToken = Number(value);
      continue;
    }

    if (argument.startsWith('--characters-per-token=')) {
      charactersPerToken = Number(argument.slice(argument.indexOf('=') + 1));
      continue;
    }

    if (argument === '--root-dir') {
      const value = args[++index];
      if (!value) {
        throw new Error('--root-dir requires a path');
      }
      rootDir = resolve(value);
      continue;
    }

    if (argument.startsWith('--root-dir=')) {
      const value = argument.slice(argument.indexOf('=') + 1);
      if (!value) {
        throw new Error('--root-dir requires a path');
      }
      rootDir = resolve(value);
      continue;
    }

    if (argument === '--baseline-root-dir') {
      const value = args[++index];
      if (!value) {
        throw new Error('--baseline-root-dir requires a path');
      }
      baselineRootDir = resolve(value);
      continue;
    }

    if (argument.startsWith('--baseline-root-dir=')) {
      const value = argument.slice(argument.indexOf('=') + 1);
      if (!value) {
        throw new Error('--baseline-root-dir requires a path');
      }
      baselineRootDir = resolve(value);
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  validateCharactersPerToken(charactersPerToken);
  return { charactersPerToken, rootDir, baselineRootDir, help };
}

export function runTokenCostReport(args = process.argv.slice(2)) {
  const { charactersPerToken, rootDir, baselineRootDir, help } =
    parseCliArgs(args);
  if (help) {
    return [
      'Usage: npm run report:token-costs -- [--characters-per-token <number>] [--root-dir <path>] [--baseline-root-dir <path>]',
      '',
      `Defaults to ${DEFAULT_CHARACTERS_PER_TOKEN} characters per estimated token.`,
      '',
    ].join('\n');
  }

  const entries = collectTokenCostEntries({ rootDir, charactersPerToken });
  const baselineEntries = baselineRootDir
    ? collectTokenCostEntries({
        rootDir: baselineRootDir,
        charactersPerToken,
      })
    : undefined;
  return renderTokenCostReport(
    entries,
    charactersPerToken,
    baselineEntries
  );
}

function createEntry({
  platform,
  kind,
  name,
  sourcePath,
  rootDir,
  content,
  charactersPerToken,
}) {
  const characters = countCharacters(content);

  return {
    platform,
    kind,
    name,
    path: toPosixPath(relative(rootDir, sourcePath)),
    characters,
    estimatedTokens: estimateTokens(characters, charactersPerToken),
  };
}

function listDirectories(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function listMarkdownFiles(directory) {
  if (!existsSync(directory)) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(entryPath));
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      files.push(entryPath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function validateCharactersPerToken(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('characters per token must be a positive number');
  }
}

function validatePlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('at least one platform is required');
  }

  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`unsupported platform: ${platform}`);
    }
  }
}

function groupEntries(entries) {
  const rowsByKey = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}\0${entry.name}`;
    const row = rowsByKey.get(key) ?? {
      kind: entry.kind,
      name: entry.name,
      tokens: {},
    };
    row.tokens[entry.platform] = entry.estimatedTokens;
    rowsByKey.set(key, row);
  }
  return rowsByKey;
}

function calculateTotals(entries) {
  return Object.fromEntries(
    SUPPORTED_PLATFORMS.map((platform) => {
      const platformEntries = entries.filter(
        (entry) => entry.platform === platform
      );
      return [
        platform,
        platformEntries.length === 0
          ? undefined
          : platformEntries.reduce(
              (total, entry) => total + entry.estimatedTokens,
              0
            ),
      ];
    })
  );
}

function formatNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatTokens(value) {
  return value === undefined ? '—' : formatNumber(value);
}

function formatTokenDeltas(tokens, baselineTokens = {}) {
  return SUPPORTED_PLATFORMS.map((platform) => {
    const current = tokens[platform];
    const baseline = baselineTokens[platform];
    if (current === undefined && baseline === undefined) return '—';

    const delta = (current ?? 0) - (baseline ?? 0);
    if (delta === 0) return '±0';
    return delta > 0
      ? `🔴 +${formatNumber(delta)}`
      : `🟢 -${formatNumber(Math.abs(delta))}`;
  }).join(' / ');
}

function escapeMarkdownTableCell(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ');
}

function toPosixPath(path) {
  return path.split(sep).join('/');
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    process.stdout.write(runTokenCostReport());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
