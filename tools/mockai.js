#!/usr/bin/env node
'use strict';
/**
 * mockai.js — a tiny fake AI provider that speaks the OpenAI, Anthropic and Gemini wire formats.
 * Used by tools/selftest.js, and handy for trying the "AI engine" tab without a real key:
 *
 *   PC_ALLOW_PRIVATE_UPSTREAM=1 npm start            (dev switch: allows http://localhost)
 *   node tools/mockai.js 4999
 *   then in the app: AI engine → OpenAI-compatible, base url http://127.0.0.1:4999/v1, any model id, any key
 *   (the key "badbadbadbad" is answered with a 401, to see the error handling)
 */
const http = require('http');

const THEME_VARS = {
  '--bg': 'hsl(210 40% 6%)', '--bg-2': 'hsl(210 36% 10%)', '--mesh1': 'hsl(200 90% 40% / 0.3)', '--mesh2': 'hsl(260 80% 50% / 0.25)',
  '--mesh3': 'hsl(320 80% 45% / 0.2)', '--surface': 'hsl(210 30% 14% / 0.7)', '--surface-2': 'hsl(210 30% 20% / 0.7)',
  '--border': 'hsl(210 50% 80% / 0.15)', '--text': 'hsl(210 30% 95%)', '--muted': 'hsl(210 15% 65%)',
  '--accent': 'hsl(200 95% 62%)', '--accent-2': 'hsl(280 90% 70%)'
};

function answer(system, user) {
  if (/Reply with the single word OK/.test(system)) return 'OK';
  if (/You design UI themes/.test(system)) return JSON.stringify({ name: 'Mock Theme', mode: 'dark', vars: THEME_VARS });
  if (/analysis stage of a prompt compiler/.test(system)) {
    return 'Sure, here is the analysis:\n' + JSON.stringify({
      task_type: 'data analysis',
      goal: 'Analyze the supplied sales data and report trends.',
      audience: 'business stakeholders',
      tone: 'neutral',
      explicit_requirements: ['use the supplied data'],
      assumptions: ['The audience is non-technical', 'Currency is USD'],
      missing_information: ['Time period of the data'],
      risks: ['Inventing numbers'],
      success_criteria: ['Every claim is backed by the data'],
      persona: 'a senior data analyst',
      data_present: false,
      output_format: 'sections'
    });
  }
  if (/strict reviewer of compiled prompts/.test(system)) {
    return JSON.stringify({ verdict: 'revise', issues: [{ severity: 'high', problem: 'Output format is not pinned down', fix: 'Add an explicit output schema' }] });
  }
  if (/Return the improved FINAL prompt/.test(system)) {
    const fed = /Output format is not pinned down/.test(user) ? ' (review feedback applied)' : '';
    return 'REFINED PROMPT' + fed + '\nYou are a careful senior analyst. Analyze the data step by step and answer in the required sections.\n';
  }
  return 'DRAFT PROMPT\nYou are a careful senior analyst. Analyze the data step by step and answer in the required sections.\n';
}

function create() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      let kind, key, system, user;
      if (req.url.endsWith('/chat/completions')) {
        kind = 'openai';
        key = String(req.headers.authorization || '').replace(/^Bearer /, '');
        system = body.messages[0].content; user = body.messages[1].content;
      } else if (req.url.endsWith('/messages')) {
        kind = 'anthropic';
        key = req.headers['x-api-key'];
        system = body.system; user = body.messages[0].content;
      } else if (/:generateContent$/.test(req.url)) {
        kind = 'google';
        key = req.headers['x-goog-api-key'];
        system = body.systemInstruction.parts[0].text; user = body.contents[0].parts[0].text;
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'no such route' } }));
      }
      calls.push({ kind, key, url: req.url, system, user });
      if (key === 'badbadbadbad') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API key badbadbadbad' } }));
      }
      const text = answer(system, user);
      const out = kind === 'openai' ? { choices: [{ message: { role: 'assistant', content: text } }] }
        : kind === 'anthropic' ? { content: [{ type: 'text', text }] }
          : { candidates: [{ content: { parts: [{ text }] } }] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return { server, calls };
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 4999;
  create().server.listen(port, '127.0.0.1', () => console.log(`mockai listening on http://127.0.0.1:${port} (openai /v1, anthropic /v1, gemini /v1beta)`));
}

module.exports = { create };
