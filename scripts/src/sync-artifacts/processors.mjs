import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
        ? renderCodexAgentToml(agentDir, raw, platformKey)
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

function renderCodexAgentToml(agentDir, raw, platformKey) {
  const description = extractAgentDescription(raw);
  const developerInstructions = stripLeadingFrontmatter(
    renderArtifact(raw, platformKey)
  ).trim();

  return [
    `name = ${tomlString(agentDir)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlMultilineLiteral(developerInstructions)}`,
    '',
  ].join('\n');
}

function extractAgentDescription(raw) {
  const match = raw.match(/^\s*description:\s*(.+)$/m);
  if (!match) {
    throw new Error('Expected source agent to define a description');
  }

  return match[1].trim();
}

function stripLeadingFrontmatter(content) {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlMultilineLiteral(value) {
  if (value.includes("'''")) {
    return tomlString(value);
  }

  return `'''\n${value}\n'''`;
}
