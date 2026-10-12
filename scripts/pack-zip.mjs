/**
 * scripts/pack-zip.mjs
 *
 * Packages the core runtime into dist/ai-bridge.zip and generates dist/ai-bridge.hash.
 * Used for JetBrains plugin distribution and CI release artifacts.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');
const distDir = join(rootDir, 'dist');
const zipFile = join(distDir, 'ai-bridge.zip');
const hashFile = join(distDir, 'ai-bridge.hash');

console.log('[pack-zip] Root directory:', rootDir);
console.log('[pack-zip] Target zip:', zipFile);

// 1. Ensure dist directory exists
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}
if (existsSync(zipFile)) {
  rmSync(zipFile);
}
if (existsSync(hashFile)) {
  rmSync(hashFile);
}

// 2. Execute zip command
// Exclude tests, development configs, git, and dist itself
const excludePatterns = [
  'dist/*',
  '.git/*',
  '.github/*',
  'scripts/*',
  '*.test.*',
  '*/*.test.*',
  '*/*/*.test.*',
  '.DS_Store',
  'coverage/*',
  'node_modules/.package-lock.json',
];

const excludeArgs = excludePatterns.map((p) => `-x "${p}"`).join(' ');
const cmd = `zip -r -y "${zipFile}" . ${excludeArgs}`;

console.log('[pack-zip] Creating zip archive...');
execSync(cmd, { cwd: rootDir, stdio: 'inherit' });

if (!existsSync(zipFile)) {
  console.error('[pack-zip] Error: zip file was not generated!');
  process.exit(1);
}

// 3. Compute SHA-256 hash
const buffer = readFileSync(zipFile);
const hash = createHash('sha256').update(buffer).digest('hex');
writeFileSync(hashFile, hash, 'utf-8');

console.log(`[pack-zip] ✓ Archive created: ${zipFile}`);
console.log(`[pack-zip] ✓ Size: ${(buffer.length / 1024 / 1024).toFixed(3)} MB`);
console.log(`[pack-zip] ✓ SHA-256: ${hash}`);
