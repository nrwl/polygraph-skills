import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const channel = process.argv[2];
const specifier = process.argv[3] ?? 'patch';

if (!['next', 'latest'].includes(channel)) {
  console.error('Usage: node release.mjs <next|latest> [patch|minor|major]');
  process.exit(1);
}
if (!['patch', 'minor', 'major'].includes(specifier)) {
  console.error('Usage: node release.mjs <next|latest> [patch|minor|major]');
  process.exit(1);
}

const PACKAGE_NAME = '@polygraph/claude-plugin';

function npm(args, capture = false) {
  return execSync(`npm ${args}`, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit',
  });
}

// Base the bump on the published `latest` dist-tag so an intervening `-next`
// version already sitting in package.json doesn't skew the stable sequence.
// Fall back to the working-tree version when the registry has nothing (first
// release, or offline).
let base = '';
try {
  base = npm(`view ${PACKAGE_NAME} dist-tags.latest`, true).trim();
} catch {
  base = '';
}
if (!base) {
  base = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  console.log(`No published latest dist-tag; basing bump on package.json ${base}`);
}

// Pin package.json to the registry base, then bump from it. `next` always
// previews the next patch; the specifier applies to `latest` only.
npm(`version ${base} --no-git-tag-version --allow-same-version`);
const bumpSpecifier = channel === 'latest' ? specifier : 'patch';
const bumped = npm(`version ${bumpSpecifier} --no-git-tag-version`, true)
  .trim()
  .replace(/^v/, '');

let version = bumped;
if (channel === 'next') {
  const run = process.env.RUN_NUMBER;
  if (!run) {
    console.error('RUN_NUMBER is required for next releases');
    process.exit(1);
  }
  version = `${bumped}-next.${run}`;
  npm(`version ${version} --no-git-tag-version --allow-same-version`);

  // The `next` build is committed into the release PR, so point the
  // `polygraph-next` marketplace entry at it here rather than pushing to main
  // from the publish job.
  const marketplacePath = join(root, '.claude-plugin', 'marketplace.json');
  const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
  const entry = marketplace.plugins.find((p) => p.name === 'polygraph-next');
  if (!entry) {
    throw new Error('polygraph-next entry not found in marketplace.json');
  }
  entry.source.version = version;
  writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
}

console.log(`Prepared ${channel} release v${version}`);
