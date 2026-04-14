import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

export function renderArtifact(raw, platformKey) {
  const result = liquid.parseAndRenderSync(raw, { platform: platformKey });
  const normalized =
    platformKey === 'claude'
      ? result
      : result.replace(/Claude Code/g, 'AI agent');
  return normalizeLeadingFrontmatter(normalized).replace(/\n{3,}/g, '\n\n');
}

function normalizeLeadingFrontmatter(content) {
  const frontmatter = content.match(/^---\n[\s\S]*?\n---/);
  if (!frontmatter) {
    return content;
  }

  const frontmatterEnd = frontmatter[0].length;
  if (content[frontmatterEnd] === '\n' || content[frontmatterEnd] === undefined) {
    return content;
  }

  return `${content.slice(0, frontmatterEnd)}\n${content.slice(frontmatterEnd)}`;
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
    },
    opencode: {
      outputDir: join(distDir, 'opencode'),
      supportsAgents: true,
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
    },
    codex: {
      outputDir: join(distDir, 'codex'),
      supportsAgents: false,
      agentsDir: null,
      agentsExt: null,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
    },
  };
}
