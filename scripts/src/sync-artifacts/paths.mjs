import { join } from 'node:path';

export const rootDir = join(import.meta.dirname, '..', '..', '..');
export const sourceDir = join(rootDir, 'source');
export const distDir = join(rootDir, 'dist');
export const legacyGeneratedDir = join(rootDir, 'generated');
