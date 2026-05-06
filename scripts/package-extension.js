#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, rmSync } = require('node:fs');
const { basename, join } = require('node:path');

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
rmSync(packagePath, { force: true });

execFileSync('zip', ['-X', '-q', packagePath, ...files], { cwd: root, stdio: 'inherit' });

console.log(`Created ${join('dist', basename(packagePath))}`);
