'use strict';
/**
 * uplink.js — talks to an AI provider. Three native formats:
 *
 *   openai     OpenAI-compatible /chat/completions (OpenAI, OpenRouter, DeepSeek, xAI, Groq, Ollama…)
 *   anthropic  Anthropic Messages API
 *   google     Gemini generateContent
 *
 * Two kinds of engine:
 *   - user engine (bring your own key): validated by validate(), sent per request by the browser,
 *     held in memory for that one job, never stored, never logged. Because the server makes the call
 *     on behalf of strangers, every outgoing connection is SSRF-guarded: https only, no credentials
 *     in the url, and the resolved ip must be public (checked at connect time, so DNS rebinding
 *     cannot slip past). Redirects are never followed. Responses are size-capped.
 *   - server engine (optional, the site owner's own key): PC_UPSTREAM_URL / PC_UPSTREAM_KEY /
 *     PC_UPSTREAM_MODEL environment variables. Trusted, so it may point at localhost (e.g. Ollama).
 *
 * Dev/test switch: PC_ALLOW_PRIVATE_UPSTREAM=1 allows http:// and private addresses, and lets any
 * provider use a custom base url. Never set it on a public server.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const PROVIDERS = {
  openai: { label: 'OpenAI-compatible', base: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', base: 'https://api.anthropic.com/v1' },
  google: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta' }
};

const MODEL_RX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const MAX_RESPONSE = 2 * 1024 * 1024;
const allowPrivate = () => process.env.PC_ALLOW_PRIVATE_UPSTREAM === '1';

/* ------------------------------------------------------------ ssrf guard */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('::ffff:')) {
    const v4 = s.slice(7);
    return net.isIPv4(v4) ? isPrivateIp(v4) : true; // hex-form mapped addresses: block to be safe
  }
  return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}

/** dns lookup that refuses private addresses at connect time */
function guardedLookup(hostname, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs || !addrs.length) return cb(new Error('host did not resolve'));
    if (!allowPrivate() && addrs.some((a) => isPrivateIp(a.address))) return cb(new Error('blocked: host resolves to a private address'));
    if (opts && opts.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

function parseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Base URL is not a valid URL.'); }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && allowPrivate()))) throw new Error('Base URL must start with https://');
  if (u.username || u.password) throw new Error('Base URL must not contain credentials.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowPrivate() && isPrivateIp(host)) throw new Error('Base URL points to a private address.');
  return u;
}

/* -------------------------------------------------------------- plumbing */

const scrub = (s, key) => (key ? String(s).split(key).join('[key]') : String(s));

function post(urlStr, headers, body, { timeoutMs, trusted }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = trusted ? new URL(urlStr) : parseUrl(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'user-agent': 'promptc' },
      lookup: trusted ? undefined : guardedLookup
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) { req.destroy(new Error('The provider response was too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => finish(reject, e));
    });
    const timer = setTimeout(() => req.destroy(new Error('The provider did not answer in time.')), timeoutMs);
    req.on('error', (e) => finish(reject, e));
    req.end(payload);
  });
}

function explain(status, text, key) {
  let detail = '';
  try {
    const j = JSON.parse(text);
    detail = (j.error && (j.error.message || j.error)) || j.message || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* not json */ }
  detail = scrub(detail, key).replace(/\s+/g, ' ').slice(0, 200);
  const head = status === 401 || status === 403 ? 'The provider rejected the API key'
    : status === 404 ? 'Model or endpoint not found — check the model id'
      : status === 429 ? 'Rate limit or quota reached'
        : status === 400 ? 'The provider rejected the request'
          : status >= 500 ? 'The provider had a server error'
            : 'Unexpected response from the provider';
  return `${head} (HTTP ${status})${detail ? ': ' + detail : ''}`;
}

function buildRequest(e, system, user) {
  if (e.provider === 'anthropic') {
    return {
      url: e.baseUrl + '/messages',
      headers: { 'x-api-key': e.key, 'anthropic-version': '2023-06-01' },
      body: { model: e.model, max_tokens: 8192, system, messages: [{ role: 'user', content: user }] },
      extract: (d) => (d.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    };
  }
  if (e.provider === 'google') {
    return {
      url: `${e.baseUrl}/models/${encodeURIComponent(e.model)}:generateContent`,
      headers: { 'x-goog-api-key': e.key },
      body: { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] },
      extract: (d) => ((((d.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join('')
    };
  }
  return {
    url: e.baseUrl + '/chat/completions',
    headers: { authorization: 'Bearer ' + e.key },
    body: { model: e.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
    extract: (d) => d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content
  };
}

/* ------------------------------------------------------------------- api */

function serverEngine() {
  const url = (process.env.PC_UPSTREAM_URL || '').replace(/\/+$/, '');
  const key = process.env.PC_UPSTREAM_KEY || '';
  const model = process.env.PC_UPSTREAM_MODEL || '';
  if (!url || !key || !model) return null;
  return { provider: 'openai', baseUrl: url, key, model, trusted: true, server: true };
}

/** the engine a job should use: the user's own (already validated), else the server's, else null */
function resolve(engine) {
  return engine || serverEngine();
}

function enabled(engine) {
  return Boolean(resolve(engine));
}

function label(engine) {
  const e = resolve(engine);
  if (!e) return 'built-in';
  return `${e.server ? 'Server engine' : PROVIDERS[e.provider].label} · ${e.model}`;
}

/** validates engine settings sent by a browser; returns a clean engine or throws a readable Error */
function validate(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Engine settings are missing.');
  const provider = String(raw.provider || '');
  if (!PROVIDERS[provider]) throw new Error('Unknown provider.');
  const model = String(raw.model || '').trim().replace(/^models\//, '');
  if (!MODEL_RX.test(model)) throw new Error('The model id looks invalid.');
  const key = String(raw.key || '').trim();
  if (key.length < 8 || key.length > 500 || /[\s\u0000-\u001f]/.test(key)) throw new Error('The API key looks invalid.');
  let baseUrl = PROVIDERS[provider].base;
  const custom = raw.baseUrl && String(raw.baseUrl).trim();
  if (custom && (provider === 'openai' || allowPrivate())) {
    baseUrl = String(raw.baseUrl).trim().replace(/\/+$/, '');
    if (baseUrl.length > 200) throw new Error('Base URL is too long.');
    parseUrl(baseUrl);
  }
  return { provider, model, key, baseUrl, trusted: false };
}

/**
 * @param {{system:string, user:string, engine?:object|null, timeoutMs?:number}} opts
 * @returns {Promise<string>} the model's text answer
 */
async function chat({ system, user, engine, timeoutMs = 90000 }) {
  const e = resolve(engine);
  if (!e) throw new Error('No AI engine is configured.');
  const r = buildRequest(e, system, user);
  let res;
  try {
    res = await post(r.url, r.headers, r.body, { timeoutMs, trusted: Boolean(e.trusted) });
  } catch (err) {
    throw new Error(scrub(err && err.message ? err.message : String(err), e.key));
  }
  if (res.status < 200 || res.status >= 300) throw new Error(explain(res.status, res.text, e.key));
  let data;
  try { data = JSON.parse(res.text); } catch { throw new Error('The provider returned something that is not JSON.'); }
  const text = r.extract(data);
  if (!text || !String(text).trim()) throw new Error('The provider returned an empty answer.');
  return String(text);
}

module.exports = { chat, enabled, validate, label, resolve, isPrivateIp, PROVIDERS };
