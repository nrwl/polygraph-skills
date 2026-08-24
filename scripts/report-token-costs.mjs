import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(import.meta.dirname, '..');

export const DEFAULT_CHARACTERS_PER_TOKEN = 4;

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
} = {}) {
  validateCharactersPerToken(charactersPerToken);

  const sourceDir = join(rootDir, 'source');
  if (!existsSync(sourceDir)) {
    throw new Error(`source directory not found under ${rootDir}`);
  }

  const skillsDir = join(sourceDir, 'skills');
  const agentsDir = join(sourceDir, 'agents');
  const entries = [];

  for (const skillName of listDirectories(skillsDir)) {
    const skillPath = join(skillsDir, skillName, 'SKILL.md');
    if (!isRegularFile(skillPath)) continue;

    entries.push(
      createEntry({
        kind: 'Skill',
        name: skillName,
        filePath: skillPath,
        rootDir,
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
            kind: 'Reference',
            name: `↳ ${skillName}/${referenceName}`,
            filePath: referencePath,
            rootDir,
            charactersPerToken,
          })
        );
      }
    }
  }

  for (const agentName of listDirectories(agentsDir)) {
    const agentPath = join(agentsDir, agentName, 'AGENT.md');
    if (!isRegularFile(agentPath)) continue;

    entries.push(
      createEntry({
        kind: 'Subagent',
        name: agentName,
        filePath: agentPath,
        rootDir,
        charactersPerToken,
      })
    );
  }

  return entries;
}

export function renderTokenCostReport(
  entries,
  charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN
) {
  validateCharactersPerToken(charactersPerToken);

  const totalCharacters = entries.reduce(
    (total, entry) => total + entry.characters,
    0
  );
  const totalTokens = entries.reduce(
    (total, entry) => total + entry.estimatedTokens,
    0
  );
  const rows = entries.map((entry) =>
    `| ${entry.kind} | ${escapeMarkdownTableCell(entry.name)} | ${formatNumber(entry.characters)} | ${formatNumber(entry.estimatedTokens)} |`
  );

  return [
    '# Estimated token costs',
    '',
    `Using 1 estimated token per ${formatNumber(charactersPerToken)} characters, rounded up per file. Counts come from the canonical files in \`source/\`.`,
    '',
    '| Kind | Skill / subagent | Characters | Estimated tokens |',
    '| --- | --- | ---: | ---: |',
    ...rows,
    `| **Total** | **${formatNumber(entries.length)} files** | **${formatNumber(totalCharacters)}** | **${formatNumber(totalTokens)}** |`,
    '',
  ].join('\n');
}

export function parseCliArgs(args) {
  let charactersPerToken = DEFAULT_CHARACTERS_PER_TOKEN;
  let rootDir = projectRoot;
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

    throw new Error(`Unknown argument: ${argument}`);
  }

  validateCharactersPerToken(charactersPerToken);
  return { charactersPerToken, rootDir, help };
}

export function runTokenCostReport(args = process.argv.slice(2)) {
  const { charactersPerToken, rootDir, help } = parseCliArgs(args);
  if (help) {
    return [
      'Usage: npm run report:token-costs -- [--characters-per-token <number>] [--root-dir <path>]',
      '',
      `Defaults to ${DEFAULT_CHARACTERS_PER_TOKEN} characters per estimated token.`,
      '',
    ].join('\n');
  }

  const entries = collectTokenCostEntries({ rootDir, charactersPerToken });
  return renderTokenCostReport(entries, charactersPerToken);
}

function createEntry({
  kind,
  name,
  filePath,
  rootDir,
  charactersPerToken,
}) {
  const content = readFileSync(filePath, 'utf8');
  const characters = countCharacters(content);

  return {
    kind,
    name,
    path: toPosixPath(relative(rootDir, filePath)),
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

function formatNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
