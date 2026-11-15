'use strict';
/**
 * kernel.js — promptc http server (zero dependencies, node >= 18).
 *
 *   GET  /api/meta                 authorship + version
 *   GET  /api/models               model registry
 *   GET  /api/changelog            release history
 *   POST /api/jobs                 enqueue a compile job   {prompt, modelId, effort}
 *   GET  /api/jobs?ids=a,b         poll job status
 *   POST /api/jobs/:id/cancel      cancel a queued job
 *   POST /api/theme                AI theme generator      {vibe}
 *   GET  /api/signals              model-updater notifications
 *   POST /api/signals/:id/adopt    add a drafted model profile to the registry
 *   POST /api/signals/:id/dismiss  ignore a drafted model profile
 *   POST /api/sentinel/run         run the updater now
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/* tiny .env loader (no dotenv dependency) */
(function loadEnv() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env) && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env is fine */ }
})();

const dock = require('./core/dock');
const forge = require('./core/forge');
const prism = require('./core/prism');
const uplink = require('./core/uplink');
const { Relay } = require('./core/relay');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PACE = process.env.PC_STAGE_PACE_MS === undefined ? 280 : Number(process.env.PC_STAGE_PACE_MS) || 0;
const UI_DIR = path.join(__dirname, 'ui');
const MAX_BODY = 256 * 1024;
const INTERVAL_DAYS = 14;

const file = {
  grid: dock.p('registry', 'grid.json'),
  signals: dock.p('registry', 'signals.json'),
  pulse: dock.p('registry', 'pulse.json'),
  meta: dock.p('meta.json'),
  ledger: dock.p('ledger.json')
};

/* ------------------------------------------------------------------ queue */

const relay = new Relay({
  concurrency: 2,
  async worker(job, onStage) {
    const grid = dock.readJson(file.grid, { models: [] });
    const model = grid.models.find((m) => m.id === job.modelId);
    if (!model) throw new Error('Unknown model: ' + job.modelId);

    if (uplink.enabled()) {
      try {
        onStage('Analyzing intent', 0, 3);
        onStage(`Optimizing for ${model.label}`, 1, 3);
        const text = await uplink.chat({ system: forge.metaPrompt(model, job.effort), user: job.prompt });
        onStage('Verifying structure', 2, 3);
        const compiled = text.replace(/^```[a-z]*\n?|```\s*$/gi, '').trim() + '\n';
        const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
        return {
          compiled,
          engine: 'upstream',
          info: { type: 'upstream', typeLabel: 'upstream model', effort: job.effort, words: { from: words(job.prompt), to: words(compiled) }, tokens: { from: Math.ceil(job.prompt.length / 4), to: Math.ceil(compiled.length / 4) } }
        };
      } catch (err) {
        console.warn('[kernel] upstream failed, falling back to local engine:', err.message);
      }
    }
    const out = await forge.compile({ prompt: job.prompt, model, effort: job.effort, onStage, pace: PACE });
    return { ...out, engine: 'local' };
  }
});

/* ---------------------------------------------------------------- helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, { ...SECURITY, 'cache-control': 'no-store', ...(isObj ? { 'content-type': 'application/json; charset=utf-8' } : {}), ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* naive per-ip rate limit: 120 api calls / minute */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { n: 1, reset: now + 60000 });
    return false;
  }
  rec.n++;
  return rec.n > 120;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 60000).unref();

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const abs = path.normalize(path.join(UI_DIR, rel));
  if (!abs.startsWith(UI_DIR + path.sep)) return send(res, 403, 'Forbidden', { 'content-type': 'text/plain' });
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, { 'content-type': type, 'cache-control': 'no-cache' });
  });
}

/* ---------------------------------------------------------------- sentinel */

let sentinelBusy = false;
let lastManual = 0;

function runSentinel(force) {
  if (sentinelBusy) return false;
  sentinelBusy = true;
  const args = [path.join(__dirname, 'daemon', 'sentinel.js'), '--once'];
  if (force) args.push('--force'); else args.push('--if-due');
  const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: __dirname });
  child.on('exit', () => { sentinelBusy = false; });
  child.on('error', () => { sentinelBusy = false; });
  return true;
}

function checkDue() {
  if ((process.env.PC_SENTINEL || 'on').toLowerCase() === 'off') return;
  runSentinel(false);
}

/* -------------------------------------------------------------------- api */

async function api(req, res, url) {
  const route = url.pathname.replace(/^\/api/, '');
  const method = req.method;

  if (method === 'GET' && route === '/health') return send(res, 200, { ok: true, upstream: uplink.enabled() });

  if (method === 'GET' && route === '/meta') {
    const meta = dock.readJson(file.meta, {});
    return send(res, 200, { ...meta, version: pkg.version, upstream: uplink.enabled() });
  }

  if (method === 'GET' && route === '/models') {
    const grid = dock.readJson(file.grid, { models: [] });
    return send(res, 200, { models: grid.models, updated: grid.updated });
  }

  if (method === 'GET' && route === '/changelog') return send(res, 200, dock.readJson(file.ledger, { releases: [] }));

  if (method === 'POST' && route === '/jobs') {
    const body = await readBody(req);
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return send(res, 400, { error: 'Prompt is empty.' });
    if (prompt.length > forge.MAX_INPUT) return send(res, 400, { error: `Prompt is too long (max ${forge.MAX_INPUT} characters).` });
    if (!forge.LEVELS[body.effort]) return send(res, 400, { error: 'Unknown effort level.' });
    const grid = dock.readJson(file.grid, { models: [] });
    if (!grid.models.some((m) => m.id === body.modelId)) return send(res, 400, { error: 'Unknown model.' });
    return send(res, 202, relay.enqueue({ prompt, modelId: body.modelId, effort: body.effort }));
  }

  if (method === 'GET' && route === '/jobs') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 60);
    return send(res, 200, { jobs: relay.many(ids) });
  }

  let m = route.match(/^\/jobs\/([a-f0-9]+)\/cancel$/);
  if (method === 'POST' && m) return send(res, 200, { cancelled: relay.cancel(m[1]) });

  if (method === 'POST' && route === '/theme') {
    const body = await readBody(req);
    try {
      return send(res, 200, await prism.generate(body.vibe));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  }

  if (method === 'GET' && route === '/signals') {
    const signals = dock.readJson(file.signals, []).filter((s) => s.status === 'new');
    const pulse = dock.readJson(file.pulse, {});
    const base = pulse.lastRun ? Date.parse(pulse.lastRun) : Date.now();
    return send(res, 200, { signals, pulse: { ...pulse, nextDue: new Date(base + INTERVAL_DAYS * 864e5).toISOString() } });
  }

  m = route.match(/^\/signals\/([A-Za-z0-9_-]+)\/(adopt|dismiss)$/);
  if (method === 'POST' && m) {
    const signals = dock.readJson(file.signals, []);
    const sig = signals.find((s) => s.id === m[1]);
    if (!sig) return send(res, 404, { error: 'Signal not found.' });
    if (m[2] === 'adopt') {
      const grid = dock.readJson(file.grid, { models: [] });
      if (!grid.models.some((x) => x.id === sig.profile.id)) {
        grid.models.push(sig.profile);
        grid.updated = new Date().toISOString().slice(0, 10);
        dock.writeJson(file.grid, grid);
      }
      sig.status = 'adopted';
    } else sig.status = 'dismissed';
    dock.writeJson(file.signals, signals);
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && route === '/sentinel/run') {
    if (Date.now() - lastManual < 10 * 60 * 1000) return send(res, 429, { error: 'The updater already ran in the last 10 minutes.' });
    lastManual = Date.now();
    return send(res, 202, { started: runSentinel(true) });
  }

  return send(res, 404, { error: 'Not found' });
}

/* ----------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (limited(req.socket.remoteAddress || 'x')) return send(res, 429, { error: 'Too many requests.' });
      return await api(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'content-type': 'text/plain' });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    send(res, err.status || 500, { error: err.status ? err.message : 'Internal error' });
    if (!err.status) console.error('[kernel]', err);
  }
});

server.listen(PORT, HOST, () => {
  const meta = dock.readJson(file.meta, {});
  console.log(`promptc v${pkg.version} — ${meta.author || 'unknown'} — http://${HOST}:${PORT}`);
  console.log(uplink.enabled() ? '[kernel] upstream llm: on' : '[kernel] upstream llm: off (local compiler engine)');
  setTimeout(checkDue, 5000).unref();
  setInterval(checkDue, 6 * 3600 * 1000).unref();
});

module.exports = server;
