import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const bump = process.argv[2];
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error('Usage: node release.mjs <patch|minor|major>');
  process.exit(1);
}

execSync(`npm version ${bump} --no-git-tag-version`, { stdio: 'inherit' });

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
);
const version = packageJson.version;

console.log(`Prepared release v${version}`);
