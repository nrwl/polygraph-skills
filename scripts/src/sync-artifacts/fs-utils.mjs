import { existsSync, mkdirSync, rmSync } from 'node:fs';

export function recreateDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });
}
