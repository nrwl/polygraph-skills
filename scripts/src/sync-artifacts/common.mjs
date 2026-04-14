import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Liquid } from 'liquidjs';

export const rootDir = join(import.meta.dirname, '..', '..', '..');
export const sourceDir = join(rootDir, 'source');
export const distDir = join(rootDir, 'dist');
export const legacyGeneratedDir = join(rootDir, 'generated');

const liquid = new Liquid();

export function recreateDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
}

export function readArtifact(mdPath) {
  const raw = readFileSync(mdPath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const meta = yaml.load(fmMatch[1]) || {};
    const content = fmMatch[2];
    return { content, meta };
  }

  return { content: raw, meta: {} };
}

export function serializeYamlFrontmatter(meta) {
  const yamlContent = yaml.dump(meta, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  });
  return `---\n${yamlContent}---\n`;
}

export function validateAgentMeta(meta, filePath) {
  const missing = [];
  if (!meta.name) missing.push('name');
  if (!meta.description) missing.push('description');
  if (missing.length > 0) {
    throw new Error(
      `Missing required fields in ${filePath}: ${missing.join(', ')}`
    );
  }
}

export function validateSkillMeta(meta, filePath) {
  const missing = [];
  if (!meta.description) missing.push('description');
  if (missing.length > 0) {
    throw new Error(
      `Missing required fields in ${filePath}: ${missing.join(', ')}`
    );
  }
}

export function transformArguments(content, targetPlaceholder) {
  if (targetPlaceholder === null) {
    return content.replace(/^.*\$ARGUMENTS.*$\n?/gm, '');
  }
  if (targetPlaceholder === '$ARGUMENTS') {
    return content;
  }
  return content.replace(/\$ARGUMENTS/g, targetPlaceholder);
}

export function transformContent(content, platformKey) {
  const result = liquid.parseAndRenderSync(content, { platform: platformKey });
  const normalized =
    platformKey === 'claude'
      ? result
      : result.replace(/Claude Code/g, 'AI agent');
  return normalized.replace(/\n{3,}/g, '\n\n');
}

export function writeClaudeAgent(destPath, content, meta) {
  const frontmatter = {
    name: meta.name,
    description: meta.description,
  };
  if (meta.model) frontmatter.model = meta.model;
  if (meta.tools) frontmatter.tools = meta.tools;

  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

export function writeClaudeSkill(destPath, content, meta, config) {
  const frontmatter = {};
  if (meta.name) frontmatter.name = meta.name;
  if (meta.description) frontmatter.description = meta.description;
  if (meta['user-invocable']) {
    frontmatter['user-invocable'] = true;
    if (meta['argument-hint']) {
      frontmatter['argument-hint'] = meta['argument-hint'];
    }
  }
  if (meta['allowed-tools']) frontmatter['allowed-tools'] = meta['allowed-tools'];
  if (meta.subagent) {
    frontmatter.subagent =
      meta.subagent === true ? 'general-purpose' : meta.subagent;
    frontmatter.context = 'fork';
  }

  const transformedContent = meta['user-invocable']
    ? transformArguments(content, config.argumentsPlaceholder)
    : content;

  writeFileSync(
    destPath,
    serializeYamlFrontmatter(frontmatter) + transformedContent
  );
}

export function writeBasicSkill(destPath, content, meta) {
  const frontmatter = {};
  if (meta.name) frontmatter.name = meta.name;
  if (meta.description) frontmatter.description = meta.description;

  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

export function writeOpenCodeAgent(destPath, content, meta) {
  const frontmatter = {
    description: meta.description || '',
    mode: 'subagent',
  };

  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

export function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function createPlatformConfigs() {
  return {
    claude: {
      outputDir: join(distDir, 'claude'),
      supportsAgents: true,
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      argumentsPlaceholder: '$ARGUMENTS',
      writeAgent: writeClaudeAgent,
      writeSkill: writeClaudeSkill,
    },
    opencode: {
      outputDir: join(distDir, 'opencode'),
      supportsAgents: true,
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      argumentsPlaceholder: '$ARGUMENTS',
      writeAgent: writeOpenCodeAgent,
      writeSkill: writeBasicSkill,
    },
    codex: {
      outputDir: join(distDir, 'codex'),
      supportsAgents: false,
      agentsDir: null,
      agentsExt: null,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      argumentsPlaceholder: '$ARGUMENTS',
      writeAgent: null,
      writeSkill: writeBasicSkill,
    },
  };
}
