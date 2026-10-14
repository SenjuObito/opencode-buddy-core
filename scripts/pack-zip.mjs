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

function commandExists(cmd) {
  try {
    const checkCmd = process.platform === 'win32' ? `where.exe ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 2. Execute zip or tar command
if (commandExists('zip')) {
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
  console.log('[pack-zip] Creating zip archive with zip...');
  execSync(cmd, { cwd: rootDir, stdio: 'inherit' });
} else if (commandExists('tar')) {
  const tarExcludePatterns = [
    'dist',
    '.git',
    '.github',
    'scripts',
    '*.test.*',
    '.DS_Store',
    'coverage',
    'node_modules/.package-lock.json',
  ];
  const tarExcludeArgs = tarExcludePatterns.map((p) => `--exclude="${p}"`).join(' ');
  const cmd = `tar -a -c -f "${zipFile}" ${tarExcludeArgs} .`;
  console.log('[pack-zip] Creating zip archive with tar...');
  execSync(cmd, { cwd: rootDir, stdio: 'inherit' });
} else {
  console.error('[pack-zip] Error: Neither "zip" nor "tar" command is available.');
  process.exit(1);
}

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
