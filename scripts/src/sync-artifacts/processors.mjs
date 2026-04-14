import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  readArtifact,
  sourceDir,
  transformContent,
  validateAgentMeta,
  validateSkillMeta,
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

    const { content: rawContent, meta } = readArtifact(srcPath);
    validateAgentMeta(meta, srcPath);
    const content = transformContent(rawContent, platformKey);
    const destPath = join(destDir, `${agentDir}${config.agentsExt}`);
    config.writeAgent(destPath, content, meta);
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

    const { content: rawContent, meta } = readArtifact(srcSkillFile);
    validateSkillMeta(meta, srcSkillFile);
    const content = transformContent(rawContent, platformKey);

    const destSkillDir = join(config.outputDir, config.skillsDir, skillDir);
    mkdirSync(destSkillDir, { recursive: true });
    config.writeSkill(join(destSkillDir, config.skillsFile), content, meta, config);

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
