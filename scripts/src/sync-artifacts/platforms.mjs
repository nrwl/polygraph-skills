import { join } from 'node:path';
import { distDir } from './paths.mjs';
import {
  writeBasicSkill,
  writeClaudeAgent,
  writeClaudeSkill,
  writeOpenCodeAgent,
} from './writers.mjs';

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
