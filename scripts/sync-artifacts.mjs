import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createPlatformConfigs } from './src/sync-artifacts/platforms.mjs';
import { processAgents, processSkills } from './src/sync-artifacts/processors.mjs';
import {
  finalizeClaudeDist,
  finalizeCodexDist,
  readRootPackageJson,
} from './src/sync-artifacts/package-artifacts.mjs';
import {
  distDir,
  legacyGeneratedDir,
  rootDir,
} from './src/sync-artifacts/paths.mjs';
import { recreateDir } from './src/sync-artifacts/fs-utils.mjs';

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
