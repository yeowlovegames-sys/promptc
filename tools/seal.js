#!/usr/bin/env node
'use strict';
/**
 * seal.js — signs the authorship metadata.
 *
 *   node tools/seal.js "Your Name" your-github-handle https://github.com/you/promptc
 *   node tools/seal.js --check
 *
 * Writes author/handle/repo/year into meta.json, stores sha-256 over the canonical string, and
 * updates the copyright line in `license`. The browser recomputes the same hash on load and shows
 * "authorship sealed" or a red alert if anyone edited the attribution without re-sealing.
 *
 * Honest limit: a client-side seal is tamper-EVIDENT, not tamper-proof — anyone can fork and re-seal
 * under their own name. Your real proof of authorship is the git history: commit early, sign your
 * commits/tags, and keep the license file. See readme.md.
 */
const crypto = require('crypto');
const fs = require('fs');
const dock = require('../core/dock');

const metaFile = dock.p('meta.json');
const licenseFile = dock.p('license');
const meta = dock.readJson(metaFile, null);
if (!meta) { console.error('meta.json not found'); process.exit(1); }

const canon = (m) => [m.product, m.author, m.handle, m.year, m.license, m.repo].join('|');
const hash = (m) => crypto.createHash('sha256').update(canon(m)).digest('hex');

const argv = process.argv.slice(2);
if (argv[0] === '--check') {
  const ok = meta.seal === hash(meta);
  console.log(ok ? 'seal ok' : 'seal MISMATCH — run: node tools/seal.js "Name" handle repo-url');
  process.exit(ok ? 0 : 1);
}

if (argv[0]) meta.author = argv[0].trim();
if (argv[1]) meta.handle = argv[1].replace(/^@/, '').trim();
if (argv[2]) meta.repo = argv[2].trim();
meta.year = String(new Date().getFullYear());
meta.seal = hash(meta);
dock.writeJson(metaFile, meta);

try {
  const text = fs.readFileSync(licenseFile, 'utf8').replace(/^Copyright \(c\) .*$/m, `Copyright (c) ${meta.year} ${meta.author}`);
  fs.writeFileSync(licenseFile, text);
} catch { /* license missing: ignore */ }

// keep the static <meta name="author"> in index.html in step
try {
  const htmlFile = dock.p('ui', 'index.html');
  const html = fs.readFileSync(htmlFile, 'utf8').replace(/<meta name="author" content="[^"]*">/, `<meta name="author" content="${meta.author.replace(/"/g, '&quot;')}">`);
  fs.writeFileSync(htmlFile, html);
} catch { /* ignore */ }

console.log(`sealed: ${meta.author} (@${meta.handle}) ${meta.year}\nsha256: ${meta.seal}`);
