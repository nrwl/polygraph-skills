/**
 * CI drift check for the committed Codex marketplace plugin dir.
 *
 * Regenerates .agents/plugins/polygraph/ by running sync-artifacts, then
 * checks git status to detect uncommitted changes. Exits non-zero when drift
 * is found so CI fails on stale committed files.
 *
 * Run via: node scripts/check-codex-marketplace.mjs
 */

import { execSync } from 'node:child_process';

// Regenerate the marketplace plugin dir from source.
try {
  execSync('node scripts/sync-artifacts.mjs', {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
} catch (err) {
  console.error('sync-artifacts failed:', err.message);
  process.exit(2);
}

// Check for uncommitted changes in the marketplace plugin dir.
let diff;
try {
  diff = execSync('git diff --name-only .agents/plugins/polygraph/ .agents/plugins/marketplace.json', {
    encoding: 'utf8',
  }).trim();
} catch {
  // git diff exits non-zero on error, not on diff output.
  diff = '';
}

// Also check for untracked files (new files that haven't been `git add`-ed).
let untracked;
try {
  untracked = execSync(
    'git ls-files --others --exclude-standard .agents/plugins/polygraph/ .agents/plugins/marketplace.json',
    { encoding: 'utf8' }
  ).trim();
} catch {
  untracked = '';
}

const driftedFiles = [
  ...(diff ? diff.split('\n') : []),
  ...(untracked ? untracked.split('\n') : []),
].filter(Boolean);

if (driftedFiles.length === 0) {
  console.log('Codex marketplace plugin dir is up-to-date.');
  process.exit(0);
} else {
  console.error(
    'Codex marketplace plugin dir (.agents/plugins/polygraph/) is out of sync with source.\n' +
    'Run `npm run sync-artifacts` and commit the updated files.\n\n' +
    'Drifted files:\n' +
    driftedFiles.map((f) => `  ${f}`).join('\n')
  );
  process.exit(1);
}
