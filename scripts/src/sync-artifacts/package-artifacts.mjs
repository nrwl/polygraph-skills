import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { distDir, rootDir, sourceDir, writeJson } from './common.mjs';

export function readRootPackageJson() {
  return JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
}

export function buildMcpConfig(agentType) {
  const env = agentType ? { POLYGRAPH_AGENT_TYPE: agentType } : undefined;

  return {
    mcpServers: {
      'polygraph-mcp': {
        type: 'stdio',
        command: 'npx',
        args: ['@polygraph/mcp@latest'],
        ...(env ? { env } : {}),
      },
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

export function buildCodexPluginManifest(pkgJson) {
  return {
    name: 'polygraph',
    version: pkgJson.version,
    description: pkgJson.description,
    author: pkgJson.author,
    homepage: 'https://docs.trypolygraph.com/',
    repository: pkgJson.repository,
    license: pkgJson.license,
    keywords: pkgJson.keywords,
    skills: './skills/',
    mcpServers: './.mcp.json',
    hooks: './hooks/hooks.json',
    interface: {
      displayName: 'Polygraph',
      shortDescription: 'Cross-repo visibility and persistent memory for Codex agents.',
      longDescription:
        'Give Codex the Polygraph meta-harness: repository graph context, resumable agent sessions, linked PR and CI state, and workflows for coordinating work across repo boundaries when needed.',
      developerName: pkgJson.author.name,
      category: 'Productivity',
      capabilities: ['Read', 'Write'],
      websiteURL: 'https://docs.trypolygraph.com/',
      defaultPrompt: [
        'Start a Polygraph session for this work.',
        'Start a Polygraph session and include the repos related to this change.',
        'Resume or inspect my Polygraph session and summarize the current state.',
      ],
      brandColor: "#F59E0B",
      composerIcon: "./assets/polygraph-icon.png",
      logo: "./assets/polygraph-icon.png",
    },
  };
}

function buildPublishPackageJson(pkgJson, packageName, files, extraFields = {}) {
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
    ...extraFields,
  };
}

export function buildOpenCodePackageJson(pkgJson) {
  return buildPublishPackageJson(pkgJson, '@polygraph/opencode-plugin', [
    'server.js',
    'agent-capture-mapping.mjs',
    'skills/',
    'agents/',
    'README.md',
  ], {
    type: 'module',
    exports: {
      './server': './server.js',
    },
    main: './server.js',
    dependencies: {
      'js-yaml': pkgJson.devDependencies['js-yaml'],
    },
  });
}

function copySharedDocs(targetDir) {
  for (const file of ['README.md', 'LICENSE']) {
    const srcPath = join(rootDir, file);
    if (existsSync(srcPath)) {
      cpSync(srcPath, join(targetDir, file));
    }
  }
}

export function finalizeClaudeDist(pkgJson) {
  const claudeDir = join(distDir, 'claude');
  const pluginDir = join(claudeDir, '.claude-plugin');
  mkdirSync(pluginDir, { recursive: true });

  writeJson(
    join(claudeDir, 'package.json'),
    buildPublishPackageJson(pkgJson, '@polygraph/claude-plugin', [
      'skills/',
      'agents/',
      'hooks/',
      '.mcp.json',
      '.claude-plugin/',
      'README.md',
    ])
  );
  writeJson(join(claudeDir, '.mcp.json'), buildMcpConfig());
  writeJson(join(pluginDir, 'plugin.json'), buildClaudePluginManifest(pkgJson));

  const sourceHooksDir = join(sourceDir, 'hooks');
  if (existsSync(sourceHooksDir)) {
    cpSync(sourceHooksDir, join(claudeDir, 'hooks'), { recursive: true });
  }

  copySharedDocs(claudeDir);
}

export function finalizeCodexDist(pkgJson) {
  const codexDir = join(distDir, 'codex');
  const pluginDir = join(codexDir, '.codex-plugin');
  mkdirSync(pluginDir, { recursive: true });
  bundleCodexInstaller(codexDir);

  writeJson(
    join(codexDir, 'package.json'),
    buildPublishPackageJson(pkgJson, '@polygraph/codex-plugin', [
      '.codex-plugin/',
      'skills/',
      'agents/',
      'hooks/',
      'assets/',
      '.mcp.json',
      'README.md',
      'bin/',
    ], {
      bin: {
        'polygraph-codex-plugin': './bin/polygraph-codex-plugin.mjs',
      },
    })
  );
  writeJson(join(codexDir, '.mcp.json'), buildMcpConfig('codex'));
  writeJson(join(pluginDir, 'plugin.json'), buildCodexPluginManifest(pkgJson));

  // Plugin-bundled SessionStart hooks. Reuses the same re-injection and
  // capture-mapping scripts as the Claude plugin; Codex resolves ${PLUGIN_ROOT}
  // in the hook commands and injects stdout `additionalContext` exactly like
  // Claude Code does.
  const codexHooksDir = join(codexDir, 'hooks');
  mkdirSync(codexHooksDir, { recursive: true });
  cpSync(
    join(sourceDir, 'codex', 'hooks', 'hooks.json'),
    join(codexHooksDir, 'hooks.json')
  );
  cpSync(
    join(sourceDir, 'hooks', 'reinject-polygraph-context.mjs'),
    join(codexHooksDir, 'reinject-polygraph-context.mjs')
  );
  cpSync(
    join(sourceDir, 'hooks', 'record-session-mapping.mjs'),
    join(codexHooksDir, 'record-session-mapping.mjs')
  );
  cpSync(
    join(sourceDir, 'hooks', 'check-plugin-version.mjs'),
    join(codexHooksDir, 'check-plugin-version.mjs')
  );

  cpSync(
    join(sourceDir, 'assets'),
    join(codexDir, 'assets'),
    {
      recursive: true
    }
  )

  copySharedDocs(codexDir);
}

export function finalizeOpenCodeDist(pkgJson) {
  const opencodeDir = join(distDir, 'opencode');
  mkdirSync(opencodeDir, { recursive: true });

  writeJson(
    join(opencodeDir, 'package.json'),
    buildOpenCodePackageJson(pkgJson)
  );

  cpSync(
    join(sourceDir, 'opencode', 'server.js'),
    join(opencodeDir, 'server.js')
  );
  cpSync(
    join(sourceDir, 'opencode', 'agent-capture-mapping.mjs'),
    join(opencodeDir, 'agent-capture-mapping.mjs')
  );
  copySharedDocs(opencodeDir);
}

function bundleCodexInstaller(codexDir) {
  const outputPath = join(codexDir, 'bin', 'polygraph-codex-plugin.mjs');
  mkdirSync(join(codexDir, 'bin'), { recursive: true });

  buildSync({
    entryPoints: [join(sourceDir, 'codex', 'bin', 'polygraph-codex-plugin.mjs')],
    outfile: outputPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    packages: 'bundle',
    logLevel: 'silent',
  });

  chmodSync(outputPath, 0o755);
}
