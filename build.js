#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const args = process.argv.slice(2);
const targets = [];
let doPackage = false;

for (const arg of args) {
  if (arg === '--package') doPackage = true;
  else if (arg === 'firefox' || arg === 'chrome') targets.push(arg);
}

if (targets.length === 0) targets.push('firefox', 'chrome');

// ── Helpers ──

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  mkdirp(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function concatFiles(files, destPath) {
  mkdirp(path.dirname(destPath));
  const content = files
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf-8'))
    .join('\n\n');
  fs.writeFileSync(destPath, content);
}

function createZip(sourceDir, zipPath) {
  const absSource = path.resolve(sourceDir);
  const absZip = path.resolve(zipPath);
  // Remove existing zip
  if (fs.existsSync(absZip)) fs.unlinkSync(absZip);
  execSync(`cd "${absSource}" && zip -r "${absZip}" .`, { stdio: 'pipe' });
}

// ── Shared file lists ──

const SHARED_MODULES = [
  'src/shared/constants.js',
  'src/shared/utils.js',
  'src/shared/detector.js',
];

const BG_BUNDLE_FILES = [
  ...SHARED_MODULES,
  'src/background/background.js',
  'src/background/background-chrome.js',
];

const CONTENT_BUNDLE_FILES = [...SHARED_MODULES, 'src/content/content.js'];

// ── Build Firefox ──

function buildFirefox() {
  const out = path.join(DIST, 'firefox');
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true });

  console.log('Building Firefox extension...');

  // Copy shared modules
  copyDir(path.join(SRC, 'shared'), path.join(out, 'shared'));

  // Copy background scripts (shared + firefox entry)
  mkdirp(path.join(out, 'background'));
  copyFile(
    path.join(SRC, 'background', 'background.js'),
    path.join(out, 'background', 'background.js')
  );
  copyFile(
    path.join(SRC, 'background', 'background-firefox.js'),
    path.join(out, 'background', 'background-firefox.js')
  );

  // Copy content script
  mkdirp(path.join(out, 'content'));
  copyFile(
    path.join(SRC, 'content', 'content.js'),
    path.join(out, 'content', 'content.js')
  );

  // Copy popup
  copyDir(path.join(SRC, 'popup'), path.join(out, 'popup'));

  // Copy icons
  copyDir(path.join(SRC, 'icons'), path.join(out, 'icons'));

  // Copy manifest
  copyFile(
    path.join(ROOT, 'manifests', 'firefox', 'manifest.json'),
    path.join(out, 'manifest.json')
  );

  console.log('  -> dist/firefox/');

  if (doPackage) {
    const zipPath = path.join(DIST, 'sourcemap-detector-firefox.zip');
    createZip(out, zipPath);
    console.log('  -> dist/sourcemap-detector-firefox.zip');
  }
}

// ── Build Chrome ──

function buildChrome() {
  const out = path.join(DIST, 'chrome');
  if (fs.existsSync(out)) fs.rmSync(out, { recursive: true });

  console.log('Building Chrome extension...');

  // Bundle background scripts into single service worker file
  concatFiles(
    BG_BUNDLE_FILES,
    path.join(out, 'background', 'background-chrome-bundle.js')
  );

  // Bundle content script
  concatFiles(
    CONTENT_BUNDLE_FILES,
    path.join(out, 'content', 'content-bundle.js')
  );

  // Copy popup, plus the shared utils it loads
  copyDir(path.join(SRC, 'popup'), path.join(out, 'popup'));
  copyFile(
    path.join(SRC, 'shared', 'utils.js'),
    path.join(out, 'shared', 'utils.js')
  );

  // Copy icons
  copyDir(path.join(SRC, 'icons'), path.join(out, 'icons'));

  // Copy manifest
  copyFile(
    path.join(ROOT, 'manifests', 'chrome', 'manifest.json'),
    path.join(out, 'manifest.json')
  );

  console.log('  -> dist/chrome/');

  if (doPackage) {
    const zipPath = path.join(DIST, 'sourcemap-detector-chrome.zip');
    createZip(out, zipPath);
    console.log('  -> dist/sourcemap-detector-chrome.zip');
  }
}

// ── Run ──

for (const target of targets) {
  if (target === 'firefox') buildFirefox();
  if (target === 'chrome') buildChrome();
}

console.log('Done.');
