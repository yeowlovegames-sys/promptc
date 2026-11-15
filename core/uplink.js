'use strict';
/**
 * uplink.js — optional upstream LLM connection (any OpenAI-compatible
 * /chat/completions endpoint). When configured, the compiler and the AI theme
 * generator use it; when it is missing or fails, the local engine is used.
 *
 *   PC_UPSTREAM_URL    base url, e.g. https://api.openai.com/v1
 *   PC_UPSTREAM_KEY    bearer token
 *   PC_UPSTREAM_MODEL  model id to call
 */
function cfg() {
  return {
    url: (process.env.PC_UPSTREAM_URL || '').replace(/\/+$/, ''),
    key: process.env.PC_UPSTREAM_KEY || '',
    model: process.env.PC_UPSTREAM_MODEL || ''
  };
}

function enabled() {
  const c = cfg();
  return Boolean(c.url && c.key && c.model);
}

async function chat({ system, user, json = false, temperature = 0.3, timeoutMs = 90000 }) {
  const c = cfg();
  if (!enabled()) throw new Error('upstream not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model: c.model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    };
    if (json) body.response_format = { type: 'json_object' };
    const res = await fetch(c.url + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.key },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('upstream http ' + res.status);
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error('upstream returned no content');
    return String(text);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enabled, chat };
