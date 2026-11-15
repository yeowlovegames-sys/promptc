#!/usr/bin/env node
'use strict';
/**
 * sentinel.js — model updater. Runs every 14 days.
 *
 *   node daemon/sentinel.js --once --force     run now
 *   node daemon/sentinel.js --once --if-due    run only if >= 14 days since the last run (cron / CI / kernel)
 *   node daemon/sentinel.js --daemon           stay alive and run whenever due (checked hourly)
 *
 * What it does
 *   1. Reads daemon/sources.json: official model-list endpoints (accurate, need an API key from
 *      the environment) and public changelog pages (regex scrape, low confidence).
 *   2. Finds model ids that are not in registry/grid.json and not already in registry/signals.json.
 *   3. Fetches each provider's prompting docs and extracts formatting guidance lines.
 *   4. Writes a draft model profile into registry/signals.json as a "new" signal.
 *      The UI shows a notification; nothing is added to the model list until the user clicks "Adopt".
 *   5. Records registry/pulse.json (last run, status, next due).
 *
 * A failing source never aborts the run; its error is logged and the others continue.
 */
const crypto = require('crypto');
const dock = require('../core/dock');

try { // optional .env (same loader rules as kernel.js)
  const text = require('fs').readFileSync(dock.p('.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env) && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const DAY = 864e5;
const INTERVAL_DAYS = 14;
const FILES = {
  grid: dock.p('registry', 'grid.json'),
  signals: dock.p('registry', 'signals.json'),
  pulse: dock.p('registry', 'pulse.json'),
  sources: dock.p('daemon', 'sources.json')
};
const args = new Set(process.argv.slice(2));
const log = (...a) => console.log('[sentinel]', ...a);

const norm = (id) => String(id).toLowerCase().replace(/[^a-z0-9]/g, '');

function prettify(id) {
  const parts = id.split('-');
  const out = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1])) out[out.length - 1] += '.' + p;
    else out.push(/^\d/.test(p) ? p : p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ').replace(/\bGpt\b/, 'GPT').replace(/\bLlama\b/, 'Llama');
}

async function fetchText(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'promptc-sentinel/1', accept: '*/*', ...headers }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('http ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---- source readers: each returns [{id, label}] ---- */

async function readApi(src) {
  const a = src.auth || {};
  const key = a.env ? process.env[a.env] : '';
  if (!key) return { skipped: `no ${a.env} in environment` };
  let url = src.url;
  const headers = { ...(a.extra || {}) };
  if (a.query) url += (url.includes('?') ? '&' : '?') + `${a.query}=${encodeURIComponent(key)}`;
  else headers[a.header] = (a.scheme || '') + key;
  const data = JSON.parse(await fetchText(url, headers));
  const rows = (src.idPath ? data[src.idPath] : data) || [];
  return {
    items: rows.map((r) => {
      let id = String(r[src.idField] || '');
      if (src.stripPrefix && id.startsWith(src.stripPrefix)) id = id.slice(src.stripPrefix.length);
      return { id, label: src.labelField && r[src.labelField] ? String(r[src.labelField]) : prettify(id) };
    })
  };
}

async function readPage(src) {
  const html = await fetchText(src.url);
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ');
  const found = new Set((text.match(new RegExp(src.pattern, 'gi')) || []).map((s) => s.toLowerCase()));
  return { items: [...found].map((id) => ({ id, label: prettify(id) })) };
}

/* ---- docs mining: pull short guidance lines about prompt formatting ---- */

const docCache = new Map();
async function mineDocs(urls) {
  const lines = [];
  for (const url of urls || []) {
    try {
      if (!docCache.has(url)) {
        const html = await fetchText(url);
        const text = html
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ')
          .replace(/<(li|p|h\d|br)[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const picks = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
          .filter((l) => l.length >= 40 && l.length <= 220 && /(prompt|instruction|format|example|system|reasoning|xml|markdown|delimiter|step)/i.test(l))
          .filter((l, i, a) => a.indexOf(l) === i)
          .slice(0, 6);
        docCache.set(url, picks);
      }
      lines.push(...docCache.get(url));
    } catch (err) {
      log('docs unreachable:', url, '-', err.message);
    }
  }
  return lines.filter((l, i, a) => a.indexOf(l) === i).slice(0, 6);
}

/* ---- main ---- */

function isDue(pulse, tolerantDays) {
  if (!pulse.lastRun) return true;
  return Date.now() - Date.parse(pulse.lastRun) >= tolerantDays * DAY;
}

async function runOnce() {
  const pulse = dock.readJson(FILES.pulse, {});
  if (args.has('--if-due') && !args.has('--force') && !isDue(pulse, INTERVAL_DAYS)) {
    log('not due yet (last run ' + pulse.lastRun + ')');
    return;
  }

  const grid = dock.readJson(FILES.grid, { models: [] });
  const signals = dock.readJson(FILES.signals, []);
  const known = new Set(grid.models.map((m) => norm(m.id)).concat(signals.map((s) => norm(s.profile.id))));
  const { sources } = dock.readJson(FILES.sources, { sources: [] });

  let created = 0;
  let failed = 0;
  let skipped = 0;
  for (const src of sources) {
    let res;
    try {
      res = src.kind === 'api' ? await readApi(src) : await readPage(src);
    } catch (err) {
      failed++;
      log(`${src.provider} (${src.url}) failed:`, err.message);
      continue;
    }
    if (res.skipped) { skipped++; log(`${src.provider}: skipped (${res.skipped})`); continue; }
    const pattern = new RegExp(src.pattern, 'i');
    const exclude = src.exclude ? new RegExp(src.exclude, 'i') : null;
    const fresh = res.items.filter((it) => pattern.test(it.id) && !(exclude && exclude.test(it.id)) && !known.has(norm(it.id)));
    if (!fresh.length) { log(`${src.provider}: nothing new`); continue; }
    const notes = await mineDocs(src.docs);
    for (const it of fresh) {
      known.add(norm(it.id));
      const id = it.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const today = new Date().toISOString().slice(0, 10);
      signals.push({
        id: 'sig-' + crypto.createHash('sha1').update(id).digest('hex').slice(0, 10),
        kind: 'new-model',
        status: 'new',
        found: new Date().toISOString(),
        confidence: src.kind === 'api' ? 'high' : 'low',
        source: src.url,
        profile: {
          id,
          label: it.label,
          provider: src.provider,
          family: src.family,
          tweaks: { thinking: 'prompted' },
          notes,
          added: today,
          source: 'sentinel'
        }
      });
      created++;
      log('new model drafted:', it.label, `(${src.provider}, ${src.kind === 'api' ? 'api' : 'page scrape'})`);
    }
  }

  dock.writeJson(FILES.signals, signals);
  dock.writeJson(FILES.pulse, {
    lastRun: new Date().toISOString(),
    lastStatus: `${created} new, ${failed} source error(s), ${skipped} skipped (no key)`,
    intervalDays: INTERVAL_DAYS,
    found: created
  });
  log(`done: ${created} new profile(s), ${failed} failed, ${skipped} skipped`);
}

async function main() {
  if (args.has('--daemon')) {
    log('daemon started; checking hourly, running every ' + INTERVAL_DAYS + ' days');
    const loop = async () => {
      try {
        const pulse = dock.readJson(FILES.pulse, {});
        if (isDue(pulse, INTERVAL_DAYS)) { args.add('--force'); await runOnce(); args.delete('--force'); }
      } catch (err) { log('run failed:', err.message); }
    };
    await loop();
    setInterval(loop, 3600 * 1000);
    return;
  }
  await runOnce();
}

main().catch((err) => {
  console.error('[sentinel] fatal:', err);
  process.exit(1);
});
