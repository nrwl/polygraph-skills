import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { stringify as stringifyToml } from 'smol-toml';
import {
  renderArtifact,
  sourceDir,
} from './common.mjs';

export function processAgents(platformKey, config) {
  if (!config.supportsAgents) {
    return;
  }

  const srcDir = join(sourceDir, 'agents');
  if (!existsSync(srcDir)) {
    return;
  }

  const destDir = join(config.outputDir, config.agentsDir);
  mkdirSync(destDir, { recursive: true });

  const agentDirs = readdirSync(srcDir).filter((entry) =>
    statSync(join(srcDir, entry)).isDirectory()
  );

  let count = 0;
  for (const agentDir of agentDirs) {
    const srcPath = join(srcDir, agentDir, 'AGENT.md');
    if (!existsSync(srcPath)) continue;

    const raw = readFileSync(srcPath, 'utf-8');
    const content =
      config.agentsFormat === 'toml'
        ? renderCodexAgentToml(agentDir, raw, platformKey, srcPath)
        : renderArtifact(raw, platformKey);
    const destPath = join(destDir, `${agentDir}${config.agentsExt}`);
    writeArtifact(destPath, content);
    count++;
  }

  console.log(`  Processed ${count} agent(s)`);
}

export function processSkills(platformKey, config) {
  const srcDir = join(sourceDir, 'skills');
  if (!existsSync(srcDir)) {
    return;
  }

  const skillDirs = readdirSync(srcDir).filter((entry) =>
    statSync(join(srcDir, entry)).isDirectory()
  );

  let count = 0;
  for (const skillDir of skillDirs) {
    const srcSkillFile = join(srcDir, skillDir, 'SKILL.md');
    if (!existsSync(srcSkillFile)) continue;

    const raw = readFileSync(srcSkillFile, 'utf-8');
    const content = renderArtifact(raw, platformKey);

    const destSkillDir = join(config.outputDir, config.skillsDir, skillDir);
    mkdirSync(destSkillDir, { recursive: true });
    writeArtifact(join(destSkillDir, config.skillsFile), content);

    const srcSkillDir = join(srcDir, skillDir);
    for (const entry of readdirSync(srcSkillDir)) {
      const srcPath = join(srcSkillDir, entry);
      if (statSync(srcPath).isDirectory()) {
        cpSync(srcPath, join(destSkillDir, entry), { recursive: true });
      }
    }

    count++;
  }

  console.log(`  Processed ${count} skill(s)`);
}

function writeArtifact(destPath, content) {
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, content);
}

export function renderCodexAgentToml(
  agentDir,
  raw,
  platformKey,
  sourcePath = `${agentDir}/AGENT.md`
) {
  const rendered = renderArtifact(raw, platformKey);
  const { frontmatter, body } = splitLeadingFrontmatter(rendered, sourcePath);
  const description = extractAgentDescription(raw);
  const developerInstructions = body.trim();

  const agent = {
    name: agentDir,
    description,
  };

  for (const field of ['model', 'model_reasoning_effort']) {
    const value = frontmatter[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Expected "${field}" in ${sourcePath} to be a non-empty string`);
    }

    agent[field] = value.trim();
  }

  agent.developer_instructions = developerInstructions;

  return stringifyToml(agent);
}

function extractAgentDescription(raw) {
  const match = raw.match(/^\s*description:\s*(.+)$/m);
  if (!match) {
    throw new Error('Expected source agent to define a description');
  }

  return match[1].trim();
}

function splitLeadingFrontmatter(content, sourcePath) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { frontmatter: {}, body: content };

  let frontmatter;
  try {
    frontmatter = parseYaml(match[1]) ?? {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse frontmatter in ${sourcePath}: ${message}`);
  }

  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error(`Expected frontmatter in ${sourcePath} to be a YAML mapping`);
  }

  return { frontmatter, body: content.slice(match[0].length) };
}
