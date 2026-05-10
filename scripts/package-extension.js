#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');

const root = process.cwd();
const distDir = join(root, 'dist');
const manifestPath = join(root, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error('manifest.json was not found. Run this script from the extension root.');
  process.exit(1);
}

const manifest = require(manifestPath);
const packageName = `meet-maestro-merge-helper-${manifest.version || 'dev'}.zip`;
const packagePath = join(distDir, packageName);
const unpackedDir = join(distDir, 'unpacked');

const files = [
  'manifest.json',
  'background.js',
  'content.css',
  'content.js',
  'lib/api.js',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const missing = files.filter(file => !existsSync(join(root, file)));
if (missing.length > 0) {
  console.error(`Cannot package extension. Missing files: ${missing.join(', ')}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
rmSync(unpackedDir, { recursive: true, force: true });
rmSync(packagePath, { force: true });

for (const file of files) {
  const target = join(unpackedDir, file);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(root, file), target);
}

execFileSync('zip', ['-X', '-q', packagePath, ...files], { cwd: unpackedDir, stdio: 'inherit' });

console.log(`Created ${join('dist', basename(packagePath))}`);
console.log(`Created ${join('dist', 'unpacked')} for chrome://extensions Load unpacked`);
