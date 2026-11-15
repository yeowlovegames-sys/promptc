'use strict';
/**
 * dock.js — tiny json file store shared by the kernel, the sentinel and the tools.
 * Writes are atomic (write temp file, then rename) so a crash never leaves half a file.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const p = (...parts) => path.join(ROOT, ...parts);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

module.exports = { ROOT, p, readJson, writeJson };
