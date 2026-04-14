import { writeFileSync } from 'node:fs';
import { serializeYamlFrontmatter } from './frontmatter.mjs';
import { transformArguments } from './render.mjs';

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
