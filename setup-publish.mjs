import {
  cpSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');

// Clean and create dist/
console.log('Preparing dist/...');
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir, { recursive: true });

// Copy package.json to dist, removing dev-only fields
const pkgJson = JSON.parse(
  readFileSync(join(__dirname, 'package.json'), 'utf8')
);
const distPkgJson = { ...pkgJson };
delete distPkgJson.scripts;
delete distPkgJson.devDependencies;
writeFileSync(
  join(distDir, 'package.json'),
  JSON.stringify(distPkgJson, null, 2) + '\n'
);
console.log('  Copied package.json');

// Copy generated/ → dist/generated/
const generatedDir = join(__dirname, 'generated');
if (existsSync(generatedDir)) {
  cpSync(generatedDir, join(distDir, 'generated'), { recursive: true });
  console.log('  Copied generated/');
}

// Copy Claude output to root level for the Claude plugin
const claudeSkills = join(generatedDir, 'claude', 'skills');
if (existsSync(claudeSkills)) {
  cpSync(claudeSkills, join(distDir, 'skills'), { recursive: true });
  console.log('  Copied skills/');
}

const claudeAgents = join(generatedDir, 'claude', 'agents');
if (existsSync(claudeAgents)) {
  cpSync(claudeAgents, join(distDir, 'agents'), { recursive: true });
  console.log('  Copied agents/');
}

// Copy hooks/
const hooksDir = join(__dirname, 'source', 'hooks');
if (existsSync(hooksDir)) {
  cpSync(hooksDir, join(distDir, 'hooks'), { recursive: true });
  console.log('  Copied hooks/');
}

// Generate plugin metadata from package.json
const pluginName = pkgJson.polygraph?.claudePlugin?.name || 'polygraph';

// .claude-plugin/plugin.json
const pluginJson = {
  name: pluginName,
  version: pkgJson.version,
  description: pkgJson.description,
  author: pkgJson.author,
  license: pkgJson.license,
  repository: pkgJson.repository,
};
const claudePluginDir = join(distDir, '.claude-plugin');
mkdirSync(claudePluginDir, { recursive: true });
writeFileSync(
  join(claudePluginDir, 'plugin.json'),
  JSON.stringify(pluginJson, null, 2) + '\n'
);
console.log('  Generated .claude-plugin/plugin.json');

// .claude-plugin/marketplace.json
const marketplaceSrc = join(__dirname, '.claude-plugin', 'marketplace.json');
if (existsSync(marketplaceSrc)) {
  cpSync(marketplaceSrc, join(claudePluginDir, 'marketplace.json'));
  console.log('  Copied .claude-plugin/marketplace.json');
}

// .mcp.json
const mcpServers = pkgJson.polygraph?.mcpServers;
if (mcpServers) {
  const mcpJson = {};
  for (const [name, server] of Object.entries(mcpServers)) {
    mcpJson[name] = {
      type: 'stdio',
      ...server,
    };
  }
  writeFileSync(
    join(distDir, '.mcp.json'),
    JSON.stringify(mcpJson, null, 2) + '\n'
  );
  console.log('  Generated .mcp.json');
}

// Copy README.md and LICENSE if they exist
for (const file of ['README.md', 'LICENSE']) {
  const src = join(__dirname, file);
  if (existsSync(src)) {
    cpSync(src, join(distDir, file));
    console.log(`  Copied ${file}`);
  }
}

console.log('\nSetup completed successfully!');
