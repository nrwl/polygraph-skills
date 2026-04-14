import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import yaml from 'js-yaml';
import { Liquid } from 'liquidjs';

const rootDir = join(import.meta.dirname, '..');
const sourceDir = join(rootDir, 'source');
const distDir = join(rootDir, 'dist');
const legacyGeneratedDir = join(rootDir, 'generated');

function readArtifact(mdPath) {
  const raw = readFileSync(mdPath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const meta = yaml.load(fmMatch[1]) || {};
    const content = fmMatch[2];
    return { content, meta };
  }

  return { content: raw, meta: {} };
}

function serializeYamlFrontmatter(meta) {
  const yamlContent = yaml.dump(meta, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  });
  return `---\n${yamlContent}---\n`;
}

function transformArguments(content, targetPlaceholder) {
  if (targetPlaceholder === null) {
    return content.replace(/^.*\$ARGUMENTS.*$\n?/gm, '');
  }
  if (targetPlaceholder === '$ARGUMENTS') {
    return content;
  }
  return content.replace(/\$ARGUMENTS/g, targetPlaceholder);
}

function validateAgentMeta(meta, filePath) {
  const missing = [];
  if (!meta.name) missing.push('name');
  if (!meta.description) missing.push('description');
  if (missing.length > 0) {
    throw new Error(
      `Missing required fields in ${filePath}: ${missing.join(', ')}`
    );
  }
}

function validateSkillMeta(meta, filePath) {
  const missing = [];
  if (!meta.description) missing.push('description');
  if (missing.length > 0) {
    throw new Error(
      `Missing required fields in ${filePath}: ${missing.join(', ')}`
    );
  }
}

function writeClaudeAgent(destPath, content, meta) {
  const frontmatter = {
    name: meta.name,
    description: meta.description,
  };
  if (meta.model) frontmatter.model = meta.model;
  if (meta.tools) frontmatter.tools = meta.tools;

  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

function writeClaudeSkill(destPath, content, meta, config) {
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

function writeBasicSkill(destPath, content, meta) {
  const frontmatter = {};
  if (meta.name) frontmatter.name = meta.name;
  if (meta.description) frontmatter.description = meta.description;
  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

function writeOpenCodeAgent(destPath, content, meta) {
  const frontmatter = {
    description: meta.description || '',
    mode: 'subagent',
  };
  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

function mapModelToCursor(sourceModel) {
  const modelMap = {
    haiku: 'fast',
    sonnet: 'inherit',
    opus: 'inherit',
  };
  return modelMap[sourceModel] || sourceModel;
}

function writeCursorAgent(destPath, content, meta) {
  const frontmatter = {};
  if (meta.name) frontmatter.name = meta.name;
  if (meta.description) frontmatter.description = meta.description;
  if (meta.model) frontmatter.model = mapModelToCursor(meta.model);
  writeFileSync(destPath, serializeYamlFrontmatter(frontmatter) + content);
}

const liquid = new Liquid();

function transformContent(content, platformKey) {
  const result = liquid.parseAndRenderSync(content, { platform: platformKey });
  const normalized =
    platformKey === 'claude'
      ? result
      : result.replace(/Claude Code/g, 'AI agent');
  return normalized.replace(/\n{3,}/g, '\n\n');
}

function recreateDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
}

function createPlatformConfigs() {
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
    cursor: {
      outputDir: join(distDir, 'cursor'),
      supportsAgents: true,
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      argumentsPlaceholder: null,
      writeAgent: writeCursorAgent,
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

function processAgents(platformKey, config) {
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

function processSkills(platformKey, config) {
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

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function readRootPackageJson() {
  return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
}

function buildMcpConfig() {
  return {
    'polygraph-mcp': {
      type: 'stdio',
      command: 'npx',
      args: ['polygraph-mcp@latest'],
    },
  };
}

function buildClaudePluginManifest(pkgJson) {
  return {
    name: 'polygraph',
    version: pkgJson.version,
    description: pkgJson.description,
    author: pkgJson.author,
    license: pkgJson.license,
    repository: pkgJson.repository,
  };
}

function buildCodexPluginManifest(pkgJson) {
  return {
    name: 'polygraph',
    version: pkgJson.version,
    description: pkgJson.description,
    author: pkgJson.author,
    homepage: 'https://nx.dev/features/polygraph',
    repository: pkgJson.repository,
    license: pkgJson.license,
    keywords: pkgJson.keywords,
    skills: './skills/',
    mcpServers: './.mcp.json',
    interface: {
      displayName: 'Polygraph',
      shortDescription: 'Multi-repo coordination skills for Codex.',
      longDescription:
        'Coordinate work across repositories with Polygraph session setup, delegation, and CI monitoring skills.',
      developerName: pkgJson.author.name,
      category: 'Productivity',
      capabilities: ['Read', 'Write'],
      websiteURL: 'https://nx.dev/features/polygraph',
      defaultPrompt: [
        'Use Polygraph to start a multi-repo session for this change.',
        'Use Polygraph to monitor CI across all repos in my Polygraph session.',
        'Use Polygraph to delegate work to another repo in the session.',
      ],
      brandColor: '#0F172A',
    },
  };
}

function buildPublishPackageJson(pkgJson, packageName, files) {
  return {
    name: packageName,
    version: pkgJson.version,
    description: pkgJson.description,
    license: pkgJson.license,
    private: false,
    author: pkgJson.author,
    homepage: pkgJson.homepage,
    repository: pkgJson.repository,
    keywords: pkgJson.keywords,
    publishConfig: {
      access: 'public',
    },
    files,
  };
}

function copySharedDocs(targetDir) {
  for (const file of ['README.md', 'LICENSE']) {
    const srcPath = join(rootDir, file);
    if (existsSync(srcPath)) {
      cpSync(srcPath, join(targetDir, file));
    }
  }
}

function finalizeClaudeDist(pkgJson) {
  const claudeDir = join(distDir, 'claude');
  const pluginDir = join(claudeDir, '.claude-plugin');
  mkdirSync(pluginDir, { recursive: true });

  writeJson(
    join(claudeDir, 'package.json'),
    buildPublishPackageJson(pkgJson, 'polygraph-claude-plugin', [
      'skills/',
      'agents/',
      'hooks/',
      '.mcp.json',
      '.claude-plugin/',
      'README.md',
    ])
  );
  writeJson(join(claudeDir, '.mcp.json'), buildMcpConfig());
  writeJson(
    join(pluginDir, 'plugin.json'),
    buildClaudePluginManifest(pkgJson)
  );

  const marketplacePath = join(rootDir, '.claude-plugin', 'marketplace.json');
  if (existsSync(marketplacePath)) {
    cpSync(marketplacePath, join(pluginDir, 'marketplace.json'));
  }

  const sourceHooksDir = join(sourceDir, 'hooks');
  if (existsSync(sourceHooksDir)) {
    cpSync(sourceHooksDir, join(claudeDir, 'hooks'), { recursive: true });
  }

  copySharedDocs(claudeDir);
}

function finalizeCodexDist(pkgJson) {
  const codexDir = join(distDir, 'codex');
  const pluginDir = join(codexDir, '.codex-plugin');
  mkdirSync(pluginDir, { recursive: true });

  writeJson(
    join(codexDir, 'package.json'),
    buildPublishPackageJson(pkgJson, 'polygraph-codex-plugin', [
      '.codex-plugin/',
      'skills/',
      '.mcp.json',
      'README.md',
    ])
  );
  writeJson(join(codexDir, '.mcp.json'), buildMcpConfig());
  writeJson(
    join(pluginDir, 'plugin.json'),
    buildCodexPluginManifest(pkgJson)
  );
  copySharedDocs(codexDir);
}

function runSync() {
  console.log('Syncing artifacts into dist/...\n');

  if (existsSync(legacyGeneratedDir)) {
    rmSync(legacyGeneratedDir, { recursive: true });
  }
  recreateDir(distDir);
  const configs = createPlatformConfigs();

  for (const [platformKey, config] of Object.entries(configs)) {
    console.log(`[${platformKey}] → ${config.outputDir.replace(rootDir, '.')}`);
    mkdirSync(config.outputDir, { recursive: true });
    processAgents(platformKey, config);
    processSkills(platformKey, config);
    console.log('');
  }

  const pkgJson = readRootPackageJson();
  finalizeClaudeDist(pkgJson);
  finalizeCodexDist(pkgJson);

  console.log('Dist assembly complete.');
}

runSync();
