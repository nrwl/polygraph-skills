import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

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
