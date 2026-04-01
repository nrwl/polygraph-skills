import {
  cpSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, basename } from 'path';
import yaml from 'js-yaml';
import * as TOML from 'smol-toml';
import { Liquid } from 'liquidjs';

const rootDir = join(import.meta.dirname, '..');
const sourceDir = join(rootDir, 'source');
const generatedDir = join(rootDir, 'generated');

// ============== Source Reading ==============

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns { content, meta } where content is the body after frontmatter
 * and meta is the parsed YAML object.
 */
function readArtifact(mdPath) {
  const raw = readFileSync(mdPath, 'utf-8');
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (fmMatch) {
    const meta = yaml.load(fmMatch[1]) || {};
    const content = fmMatch[2];
    return { content, meta };
  }
  // No frontmatter — entire file is content
  return { content: raw, meta: {} };
}

/**
 * Serialize metadata to YAML frontmatter format
 */
function serializeYamlFrontmatter(meta) {
  const yamlContent = yaml.dump(meta, {
    lineWidth: -1,
    quotingType: "'",
    forceQuotes: false,
  });
  return `---\n${yamlContent}---\n`;
}

/**
 * Transform $ARGUMENTS placeholder to agent-specific syntax
 */
function transformArguments(content, targetPlaceholder) {
  if (targetPlaceholder === null) {
    return content.replace(/^.*\$ARGUMENTS.*$\n?/gm, '');
  }
  if (targetPlaceholder === '$ARGUMENTS') {
    return content;
  }
  return content.replace(/\$ARGUMENTS/g, targetPlaceholder);
}

/**
 * Validate required fields in metadata
 */
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

// ============== Platform Configs ==============

function createPlatformConfigs() {
  return {
    claude: {
      outputDir: join(generatedDir, 'claude'),
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      supportsAgents: true,
      argumentsPlaceholder: '$ARGUMENTS',
      writeAgent: writeClaudeAgent,
      writeSkill: writeClaudeSkill,
    },
    opencode: {
      outputDir: join(generatedDir, 'opencode'),
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      supportsAgents: true,
      argumentsPlaceholder: '$ARGUMENTS',
      writeAgent: writeOpenCodeAgent,
      writeSkill: writeBasicSkill,
    },
    copilot: {
      outputDir: join(generatedDir, 'copilot'),
      agentsDir: 'agents',
      agentsExt: '.agent.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      supportsAgents: true,
      argumentsPlaceholder: '${input:args}',
      writeAgent: writeCopilotAgent,
      writeSkill: writeBasicSkill,
    },
    cursor: {
      outputDir: join(generatedDir, 'cursor'),
      skillsOutputDir: join(generatedDir, 'shared'),
      agentsDir: 'agents',
      agentsExt: '.md',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      supportsAgents: true,
      argumentsPlaceholder: null,
      writeAgent: writeCursorAgent,
      writeSkill: writeBasicSkill,
    },
    gemini: {
      outputDir: join(generatedDir, 'gemini'),
      skillsOutputDir: join(generatedDir, 'shared'),
      agentsDir: null,
      agentsExt: null,
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      supportsAgents: false,
      argumentsPlaceholder: '{{args}}',
      writeAgent: null,
      writeSkill: writeBasicSkill,
    },
    codex: {
      outputDir: join(generatedDir, 'shared'),
      agentsOutputDir: join(generatedDir, 'codex'),
      agentsDir: 'agents',
      agentsExt: '.toml',
      skillsDir: 'skills',
      skillsFile: 'SKILL.md',
      supportsAgents: true,
      argumentsPlaceholder: '$ARGUMENTS',
      writeAgent: writeCodexAgent,
      writeSkill: writeBasicSkill,
    },
  };
}

// ============== Writer Functions ==============

function writeClaudeAgent(destPath, content, meta) {
  const frontmatter = {
    name: meta.name,
    description: meta.description,
  };
  if (meta.model) frontmatter.model = meta.model;
  if (meta['tools'])
    frontmatter['tools'] = meta['tools'];

  const output = serializeYamlFrontmatter(frontmatter) + content;
  writeFileSync(destPath, output);
}

function writeClaudeSkill(destPath, content, meta, config) {
  const frontmatter = {};
  if (meta.name) frontmatter.name = meta.name;
  if (meta.description) frontmatter.description = meta.description;

  if (meta['user-invocable']) {
    frontmatter['user-invocable'] = true;
    if (meta['argument-hint'])
      frontmatter['argument-hint'] = meta['argument-hint'];
    if (meta['allowed-tools'])
      frontmatter['allowed-tools'] = meta['allowed-tools'];
  }

  if (meta.subagent) {
    frontmatter.subagent =
      meta.subagent === true ? 'general-purpose' : meta.subagent;
    frontmatter.context = 'fork';
  }

  const transformedContent = meta['user-invocable']
    ? transformArguments(content, config.argumentsPlaceholder)
    : content;
  const output = serializeYamlFrontmatter(frontmatter) + transformedContent;
  writeFileSync(destPath, output);
}

function writeBasicSkill(destPath, content, meta) {
  const frontmatter = {};
  if (meta.name) frontmatter.name = meta.name;
  if (meta.description) frontmatter.description = meta.description;

  const output = serializeYamlFrontmatter(frontmatter) + content;
  writeFileSync(destPath, output);
}

function writeOpenCodeAgent(destPath, content, meta) {
  const frontmatter = {
    description: meta.description || '',
    mode: 'subagent',
  };

  const output = serializeYamlFrontmatter(frontmatter) + content;
  writeFileSync(destPath, output);
}

function writeCopilotAgent(destPath, content, meta) {
  const frontmatter = {
    description: meta.description || '',
  };

  const output = serializeYamlFrontmatter(frontmatter) + content;
  writeFileSync(destPath, output);
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

  const output = serializeYamlFrontmatter(frontmatter) + content;
  writeFileSync(destPath, output);
}

function toMultilineTomlString(tomlOutput, key) {
  const regex = new RegExp(`^(${key} = )"(.*)"$`, 'm');
  return tomlOutput.replace(regex, (match, prefix, content) => {
    const unescaped = content.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    return `${prefix}"""\n${unescaped}"""`;
  });
}

function writeCodexAgent(destPath, content, meta) {
  const tomlObj = {
    developer_instructions: content.trim(),
  };

  let tomlOutput = TOML.stringify(tomlObj);
  tomlOutput = toMultilineTomlString(tomlOutput, 'developer_instructions');
  writeFileSync(destPath, tomlOutput);
}

// ============== Content Transformation ==============

const liquid = new Liquid();

function transformContent(content, platformKey) {
  if (!platformKey) {
    throw new Error('transformContent: platformKey is required');
  }

  let result;
  try {
    result = liquid.parseAndRenderSync(content, {
      platform: platformKey,
    });
  } catch (err) {
    throw new Error(
      `Liquid template error (platform: ${platformKey}): ${err.message}`
    );
  }

  if (platformKey !== 'claude') {
    result = result.replace(/Claude Code/g, 'AI agent');
  }
  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

// ============== Utility Functions ==============

function recreateDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
}

// ============== Processing ==============

function processAgents(platformKey, config) {
  if (!config.supportsAgents) {
    return;
  }

  const srcDir = join(sourceDir, 'agents');
  if (!existsSync(srcDir)) {
    console.log(`  Skipped source/agents/ (source does not exist)`);
    return;
  }

  const baseDir = config.agentsOutputDir || config.outputDir;
  const destDir = join(baseDir, config.agentsDir);
  mkdirSync(destDir, { recursive: true });

  // Agents are in subdirectories: agents/{name}/AGENT.md
  const agentDirs = readdirSync(srcDir).filter((d) =>
    statSync(join(srcDir, d)).isDirectory()
  );

  let count = 0;
  for (const agentDir of agentDirs) {
    const srcPath = join(srcDir, agentDir, 'AGENT.md');
    if (!existsSync(srcPath)) continue;

    const { content: rawContent, meta } = readArtifact(srcPath);
    validateAgentMeta(meta, srcPath);
    const content = transformContent(rawContent, platformKey);
    const destPath = join(destDir, agentDir + config.agentsExt);
    config.writeAgent(destPath, content, meta);
    count++;
  }

  console.log(`  Processed ${count} agent(s) → ${config.agentsDir}/`);
}

function processSkills(platformKey, config) {
  const srcDir = join(sourceDir, 'skills');
  if (!existsSync(srcDir)) {
    console.log(`  Skipped source/skills/ (source does not exist)`);
    return;
  }

  const skillDirs = readdirSync(srcDir).filter((d) =>
    statSync(join(srcDir, d)).isDirectory()
  );

  let skillCount = 0;

  for (const skillDir of skillDirs) {
    const srcSkillFile = join(srcDir, skillDir, 'SKILL.md');
    if (!existsSync(srcSkillFile)) continue;

    const { content: rawContent, meta } = readArtifact(srcSkillFile);
    validateSkillMeta(meta, srcSkillFile);
    const content = transformContent(rawContent, platformKey);

    const skillBaseDir = config.skillsOutputDir || config.outputDir;
    const destDir = join(skillBaseDir, config.skillsDir);
    const destSkillDir = join(destDir, skillDir);
    mkdirSync(destSkillDir, { recursive: true });
    const destSkillFile = join(destSkillDir, config.skillsFile);
    config.writeSkill(destSkillFile, content, meta, config);
    skillCount++;

    // Copy supplementary directories
    const srcSkillDir = join(srcDir, skillDir);
    for (const entry of readdirSync(srcSkillDir)) {
      const srcPath = join(srcSkillDir, entry);
      if (statSync(srcPath).isDirectory()) {
        cpSync(srcPath, join(destSkillDir, entry), { recursive: true });
      }
    }
  }

  if (skillCount > 0) {
    console.log(`  Processed ${skillCount} skill(s) → ${config.skillsDir}/`);
  }
}

/**
 * Generate Codex config.toml with MCP servers and agent definitions.
 */
function writeCodexConfig() {
  const mcpServers = {
    'polygraph-mcp': {
      command: 'npx',
      args: ['polygraph-mcp@latest'],
    },
  };

  // Collect generated agent TOML files
  const codexAgentsDir = join(generatedDir, 'codex', 'agents');
  const agentEntries = {};
  if (existsSync(codexAgentsDir)) {
    const agentFiles = readdirSync(codexAgentsDir).filter((f) =>
      f.endsWith('.toml')
    );
    for (const file of agentFiles) {
      const baseName = basename(file, '.toml');
      // Read source agent metadata
      const srcAgentPath = join(sourceDir, 'agents', baseName, 'AGENT.md');
      if (existsSync(srcAgentPath)) {
        const { meta } = readArtifact(srcAgentPath);
        agentEntries[baseName] = {
          description: meta.description,
          config_file: `agents/${file}`,
        };
      }
    }
  }

  const hasAgents = Object.keys(agentEntries).length > 0;

  const parts = [];
  parts.push(TOML.stringify({ mcp_servers: mcpServers }).trim());

  if (hasAgents) {
    parts.push('');
    parts.push(TOML.stringify({ features: { multi_agent: true } }).trim());
    parts.push('');
    parts.push(TOML.stringify({ agents: agentEntries }).trim());
  }

  parts.push('');

  const codexDir = join(generatedDir, 'codex');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'config.toml'), parts.join('\n'));
  console.log('  Generated .codex/config.toml');
}

// ============== Main Execution ==============

function runSync() {
  console.log('Syncing artifacts...\n');

  recreateDir(generatedDir);

  const configs = createPlatformConfigs();

  for (const [platformKey, config] of Object.entries(configs)) {
    console.log(
      `\n[${platformKey}] → ${config.outputDir.replace(rootDir, '.')}`
    );

    mkdirSync(config.outputDir, { recursive: true });

    processAgents(platformKey, config);
    processSkills(platformKey, config);
  }

  console.log('\n[codex] Generating config...');
  writeCodexConfig();

  console.log('\nSync complete!');
}

runSync();
