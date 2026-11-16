/**
 * app.js — promptc frontend. Plain browser JS, no build step.
 * Sections: helpers · state · seal · models/composer · queue + cards · drawer (themes, css, ai) · modals · boot
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function h(tag, props) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var kids = [].concat(arguments[i]);
      for (var j = 0; j < kids.length; j++) {
        var kid = kids[j];
        if (kid == null || kid === false) continue;
        n.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return n;
  }

  function api(path, opt) {
    opt = opt || {};
    return fetch('/api' + path, {
      method: opt.method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: opt.body ? JSON.stringify(opt.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind || ''), role: 'status', text: msg });
    $('#toasts').appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 2600);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = h('textarea', { 'aria-hidden': 'true' });
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  var fmtTime = function (ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  var words = function (s) { return s.trim() ? s.trim().split(/\s+/).length : 0; };

  /* -------------------------------------------------------------------- state */
  var EFFORTS = [
    { id: 'low', label: 'Low', hint: 'Quick cleanup & formatting.' },
    { id: 'medium', label: 'Medium', hint: 'Balanced detail expansion.' },
    { id: 'high', label: 'High', hint: 'Deep structure + a few-shot example.' },
    { id: 'very_high', label: 'Very High', hint: 'Exhaustive reasoning, edge cases, strict schema.' }
  ];
  var THEMES = [
    { id: 'obsidian', name: 'Obsidian', desc: 'Sleek dark' },
    { id: 'aurora', name: 'Aurora', desc: 'Mesh gradients' },
    { id: 'glass', name: 'Glass', desc: 'Glassmorphism' },
    { id: 'paper', name: 'Paper', desc: 'Light & quiet' },
    { id: 'terminal', name: 'Terminal', desc: 'Cyber green' }
  ];
  var SNIPPETS = [
    ['Hover shine', '.btn:hover { box-shadow: 0 0 0 1px var(--accent), 0 0 30px var(--shine); }'],
    ['Gradient border', '.card { border: 1px solid transparent; background: linear-gradient(var(--surface), var(--surface)) padding-box, linear-gradient(135deg, var(--accent), var(--accent-2)) border-box; }'],
    ['Flowing button', '.btn.primary { background-size: 220% 220%; animation: flow 6s ease infinite; }\n@keyframes flow { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }'],
    ['Floating logo', '.logo-mark { animation: bob 3s ease-in-out infinite; }\n@keyframes bob { 50% { transform: translateY(-3px); } }'],
    ['Glow title', '.logo { text-shadow: 0 0 18px var(--accent); }'],
    ['Round corners', ':root { --radius: 28px; }']
  ];
  var VIBES = ['sunset synthwave', 'calm forest glass', 'paper minimal', 'neon cyber terminal', 'deep ocean aurora'];

  var state = {
    models: [],
    runs: Vault.get('runs', []),
    views: {},
    effort: Vault.get('effort', 'medium'),
    meta: null,
    signals: [],
    pulse: null,
    pollTimer: 0,
    css: Vault.get('css', ''),
    custom: Vault.get('custom_theme', null)
  };
  var ui = {};

  function persist() {
    var keep = state.runs.slice(0, 60);
    while (!Vault.set('runs', keep) && keep.length > 3) keep = keep.slice(0, Math.ceil(keep.length / 2));
  }

  /* --------------------------------------------------------------- seal / meta */
  function sha256(text) {
    if (!(window.crypto && crypto.subtle)) return Promise.resolve(null);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function sealText() {
    var m = state.meta;
    return '© ' + m.year + ' ' + m.author + ' (@' + m.handle + ') · ' + m.product + ' v' + m.version + ' · ' + m.license + ' license';
  }

  function renderSeal(stateName) {
    var m = state.meta;
    var bar = $('#seal-bar');
    bar.setAttribute('data-state', stateName);
    var text = $('#seal-text');
    text.textContent = '';
    text.appendChild(h('b', { text: sealText() }));
    $('#seal-state').textContent = stateName === 'ok' ? 'authorship sealed ✓' : stateName === 'bad' ? 'seal mismatch — attribution was modified' : 'seal cannot be verified here (needs https or localhost)';
    $('#foot').textContent = '';
    $('#foot').appendChild(document.createTextNode('Built and owned by '));
    $('#foot').appendChild(h('b', { text: m.author }));
    $('#foot').appendChild(document.createTextNode(' · ' + m.license + ' · '));
    $('#foot').appendChild(h('a', { href: m.repo, target: '_blank', rel: 'noopener noreferrer', text: 'source' }));
    document.title = 'promptc — ' + m.author;
    var authorTag = document.querySelector('meta[name="author"]');
    if (authorTag) authorTag.setAttribute('content', m.author);
  }

  function verifySeal() {
    var m = state.meta;
    var canon = [m.product, m.author, m.handle, m.year, m.license, m.repo].join('|');
    return sha256(canon).then(function (hash) {
      var s = hash === null ? 'unverified' : hash === m.seal ? 'ok' : 'bad';
      renderSeal(s);
      if (s === 'bad') showSealAlert('Authorship seal mismatch: the attribution in this copy does not match its signed metadata. Original author: ' + m.author + ' (' + m.repo + ').');
      return s;
    });
  }

  function showSealAlert(msg) {
    var a = $('#seal-alert');
    a.textContent = msg;
    a.hidden = false;
  }

  /** every 5s: the seal bar must exist, be visible and still carry the author's name */
  function watchSeal() {
    if (!state.meta) return;
    var bar = $('#seal-bar');
    var okay = false;
    if (bar && document.body.contains(bar)) {
      var cs = getComputedStyle(bar);
      var r = bar.getBoundingClientRect();
      okay = cs.display !== 'none' && cs.visibility === 'visible' && parseFloat(cs.opacity) > 0.5 && r.height > 8 && r.width > 100 && bar.textContent.indexOf(state.meta.author) !== -1;
    }
    if (!okay) showSealAlert('The authorship banner was removed, hidden or edited. Original author: ' + state.meta.author + ' (' + state.meta.repo + ').');
  }

  function loadMeta() {
    return api('/meta').then(function (m) {
      state.meta = m;
      $('#ver').textContent = 'v' + m.version;
      renderSeal('pending');
      return verifySeal();
    }).catch(function () { $('#seal-text').textContent = '© promptc — offline'; });
  }

  /* --------------------------------------------------------- models + composer */
  function loadModels() {
    return api('/models').then(function (d) {
      state.models = d.models;
      var order = ['Anthropic', 'Google', 'OpenAI', 'Other'];
      var providers = [];
      d.models.forEach(function (m) { if (providers.indexOf(m.provider) < 0) providers.push(m.provider); });
      providers.sort(function (a, b) {
        var ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      ui.model.textContent = '';
      providers.forEach(function (p) {
        var g = h('optgroup', { label: p });
        d.models.filter(function (m) { return m.provider === p; }).forEach(function (m) {
          g.appendChild(h('option', { value: m.id, text: m.label }));
        });
        ui.model.appendChild(g);
      });
      var saved = Vault.get('model', null);
      if (saved && d.models.some(function (m) { return m.id === saved; })) ui.model.value = saved;
    }).catch(function (e) { toast('Cannot reach the server: ' + e.message, 'error'); });
  }

  function buildEffort() {
    ui.effort.textContent = '';
    EFFORTS.forEach(function (e) {
      ui.effort.appendChild(h('button', {
        type: 'button', role: 'radio', 'data-id': e.id, text: e.label, 'aria-checked': String(e.id === state.effort),
        onclick: function () { setEffort(e.id); }
      }));
    });
    setEffort(state.effort);
  }

  function setEffort(id) {
    state.effort = id;
    Vault.set('effort', id);
    $$('button', ui.effort).forEach(function (b) { b.setAttribute('aria-checked', String(b.getAttribute('data-id') === id)); });
    ui.effortHint.textContent = EFFORTS.filter(function (e) { return e.id === id; })[0].hint;
  }

  function updateComposer() {
    var len = ui.input.value.length;
    ui.count.textContent = len + ' / 20000';
    ui.go.disabled = !ui.input.value.trim();
  }

  function submit() {
    var prompt = ui.input.value.trim();
    var model = state.models.filter(function (m) { return m.id === ui.model.value; })[0];
    if (!prompt || !model) return;
    Vault.set('model', model.id);
    ui.go.disabled = true;
    var payload = { prompt: prompt, modelId: model.id, effort: state.effort };
    if (engineReady()) payload.engine = engineBody();
    api('/jobs', { method: 'POST', body: payload }).then(function (j) {
      state.runs.unshift({ id: j.id, prompt: prompt, modelId: model.id, modelLabel: model.label, effort: state.effort, status: j.status, stage: j.stage, position: j.position, progress: 0, createdAt: Date.now() });
      persist();
      renderRuns();
      schedulePoll();
    }).catch(function (e) { toast(e.message, 'error'); }).then(updateComposer);
  }

  /* ---------------------------------------------------- ai engine (bring your own key) */
  var PROVIDER_NAMES = { openai: 'OpenAI-compatible', anthropic: 'Anthropic', google: 'Gemini' };
  var MODEL_HINTS = { openai: 'model id, as listed by your provider', anthropic: 'a Claude model id from your Anthropic console', google: 'a Gemini model id from Google AI Studio' };
  var PRESETS = [
    ['OpenAI', 'https://api.openai.com/v1'],
    ['OpenRouter', 'https://openrouter.ai/api/v1'],
    ['DeepSeek', 'https://api.deepseek.com/v1'],
    ['xAI', 'https://api.x.ai/v1'],
    ['Groq', 'https://api.groq.com/openai/v1']
  ];
  var memKey = '';
  var savedEngine = Vault.get('engine', null) || {};
  var engine = {
    on: !!savedEngine.on,
    provider: PROVIDER_NAMES[savedEngine.provider] ? savedEngine.provider : 'openai',
    baseUrl: String(savedEngine.baseUrl || ''),
    model: String(savedEngine.model || ''),
    remember: !!savedEngine.remember
  };

  /* the key lives in sessionStorage (gone when the tab closes) or, if the user opts in, localStorage */
  function keyGet() {
    try { return sessionStorage.getItem('promptc:ekey') || localStorage.getItem('promptc:ekey') || memKey; } catch (e) { return memKey; }
  }
  function keyClear() {
    memKey = '';
    try { sessionStorage.removeItem('promptc:ekey'); localStorage.removeItem('promptc:ekey'); } catch (e) { /* ignore */ }
  }
  function keySet(key, remember) {
    keyClear();
    memKey = key;
    try { (remember ? localStorage : sessionStorage).setItem('promptc:ekey', key); } catch (e) { /* memory only */ }
  }
  function saveEngine() {
    Vault.set('engine', { on: engine.on, provider: engine.provider, baseUrl: engine.baseUrl, model: engine.model, remember: engine.remember });
  }
  function engineReady() { return engine.on && !!engine.model && !!keyGet(); }
  function engineBody() {
    var b = { provider: engine.provider, model: engine.model, key: keyGet() };
    if (engine.provider === 'openai' && engine.baseUrl) b.baseUrl = engine.baseUrl;
    return b;
  }

  function renderPill() {
    var pill = $('#engine-pill');
    if (!pill) return;
    var ready = engineReady();
    pill.classList.toggle('on', ready || !!(state.meta && state.meta.upstream));
    if (ready) pill.textContent = '✦ AI engine: ' + PROVIDER_NAMES[engine.provider] + ' · ' + engine.model;
    else if (state.meta && state.meta.upstream) pill.textContent = '✦ AI engine: provided by this server';
    else pill.textContent = '✦ Built-in engine · connect your own AI key for smarter results';
  }

  function fillEngine() {
    $('#eng-provider').value = engine.provider;
    $('#eng-base').value = engine.baseUrl;
    $('#eng-model').value = engine.model;
    $('#eng-remember').checked = engine.remember;
    $('#eng-key').value = '';
    $('#eng-key').placeholder = keyGet() ? 'saved — paste a new key to replace it' : 'paste your key';
    $('#eng-model').placeholder = MODEL_HINTS[engine.provider];
    $('#eng-base-wrap').hidden = engine.provider !== 'openai';
    var rep = $('#eng-report');
    rep.className = 'report';
    rep.textContent = engineReady() ? 'Enabled — new prompts use your AI engine.' : '';
  }

  function bindEngine() {
    PRESETS.forEach(function (p) {
      $('#eng-presets').appendChild(h('button', { class: 'btn small', type: 'button', text: p[0], onclick: function () { $('#eng-base').value = p[1]; } }));
    });
    $('#eng-provider').addEventListener('change', function (e) {
      engine.provider = e.target.value;
      $('#eng-base-wrap').hidden = engine.provider !== 'openai';
      $('#eng-model').placeholder = MODEL_HINTS[engine.provider];
    });
    $('#eng-remember').addEventListener('change', function (e) {
      engine.remember = e.target.checked;
      if (keyGet()) keySet(keyGet(), engine.remember);
      saveEngine();
    });
    $('#eng-forget').addEventListener('click', function () {
      keyClear();
      engine.on = false;
      saveEngine();
      renderPill();
      fillEngine();
      $('#eng-report').textContent = 'Key removed from this browser. The built-in engine is active.';
    });
    $('#eng-test').addEventListener('click', function () {
      var provider = $('#eng-provider').value;
      var model = $('#eng-model').value.trim();
      var baseUrl = $('#eng-base').value.trim();
      var remember = $('#eng-remember').checked;
      var key = $('#eng-key').value.trim() || keyGet();
      var rep = $('#eng-report');
      var btn = $('#eng-test');
      if (!model || !key) { rep.className = 'report bad'; rep.textContent = 'Enter a model id and an API key.'; return; }
      var body = { provider: provider, model: model, key: key };
      if (provider === 'openai' && baseUrl) body.baseUrl = baseUrl;
      btn.disabled = true;
      rep.className = 'report';
      rep.textContent = 'Testing…';
      api('/engine/test', { method: 'POST', body: { engine: body } }).then(function (d) {
        engine.on = true; engine.provider = provider; engine.model = model; engine.baseUrl = baseUrl; engine.remember = remember;
        keySet(key, remember);
        saveEngine();
        renderPill();
        fillEngine();
        $('#eng-report').textContent = 'Connected — ' + d.label + '. New prompts will use your AI engine.';
        toast('AI engine enabled', 'ok');
      }).catch(function (e) {
        rep.className = 'report bad';
        rep.textContent = e.message;
      }).then(function () { btn.disabled = false; });
    });
    $('#engine-pill').addEventListener('click', function () { openDrawer('engine'); });
  }

  /* --------------------------------------------------------- queue polling */
  function isOpen(r) { return r.status === 'queued' || r.status === 'running'; }

  function schedulePoll() {
    if (state.pollTimer) return;
    state.pollTimer = setTimeout(tick, 600);
  }

  function tick() {
    state.pollTimer = 0;
    var open = state.runs.filter(isOpen);
    if (!open.length) return;
    api('/jobs?ids=' + open.map(function (r) { return r.id; }).join(',')).then(function (d) {
      var byId = {};
      d.jobs.forEach(function (j) { byId[j.id] = j; });
      open.forEach(function (r) {
        var j = byId[r.id];
        if (!j) { r.status = 'error'; r.error = 'This job was lost (the server restarted).'; refreshCard(r); return; }
        var changed = r.status !== j.status;
        r.status = j.status; r.stage = j.stage; r.position = j.position; r.progress = j.progress;
        if (j.status === 'done') { r.result = j.result; r.engine = j.engine; r.info = j.info; }
        if (j.status === 'error') r.error = j.error;
        changed ? refreshCard(r) : updateLive(r);
      });
      persist();
    }).catch(function () { /* transient: try again */ }).then(function () {
      if (state.runs.some(isOpen)) schedulePoll();
    });
  }

  /* ------------------------------------------------------------- run cards */
  function renderRuns() {
    ui.runs.textContent = '';
    ui.clear.hidden = state.runs.length === 0;
    if (!state.runs.length) {
      ui.runs.appendChild(h('div', { class: 'card empty', 'data-shine': true }, h('b', { text: 'Nothing compiled yet' }), 'Write a rough prompt, pick a model and an effort level, then compile.'));
      return;
    }
    state.runs.forEach(function (r) { ui.runs.appendChild(buildCard(r)); });
  }

  function cardFor(id) { return ui.runs.querySelector('[data-id="' + id + '"]'); }

  function refreshCard(r) {
    var old = cardFor(r.id);
    var fresh = buildCard(r, true);
    if (old) old.replaceWith(fresh); else ui.runs.prepend(fresh);
  }

  function updateLive(r) {
    var card = cardFor(r.id);
    if (!card) return;
    var label = $('.think-label', card);
    if (label) {
      var text = r.status === 'queued' ? 'Queued · position ' + (r.position || 1) : r.stage || 'Thinking';
      if (label.textContent !== text) {
        label.textContent = text;
        label.classList.remove('swap');
        void label.offsetWidth; // restart the crossfade without touching the dots
        label.classList.add('swap');
      }
    }
    var bar = $('.bar i', card);
    if (bar) bar.style.width = Math.round((r.progress || 0) * 100) + '%';
  }

  function buildCard(r, still) {
    var eff = EFFORTS.filter(function (e) { return e.id === r.effort; })[0];
    var card = h('article', { class: 'card run', 'data-id': r.id, 'data-shine': true });
    if (still) card.style.animation = 'none';
    card.appendChild(h('div', { class: 'run-head' },
      h('span', { class: 'chip', text: r.modelLabel }),
      h('span', { class: 'chip effort', text: eff ? eff.label : r.effort }),
      r.status === 'error' ? h('span', { class: 'chip err', text: 'failed' }) : null,
      h('span', { class: 'time', text: fmtTime(r.createdAt) }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small ghost', title: 'Load this prompt back into the editor', text: 'Reuse', onclick: function () { reuse(r); } }),
      h('button', { class: 'btn small ghost', title: 'Remove', 'aria-label': 'Remove', text: '✕', onclick: function () { removeRun(r); } })
    ));
    card.appendChild(h('p', { class: 'orig', text: r.prompt }));

    if (isOpen(r)) {
      card.appendChild(h('div', { class: 'think' },
        h('span', { class: 'think-spark', 'aria-hidden': 'true', text: '✻' }),
        h('span', { class: 'think-label', text: r.status === 'queued' ? 'Queued · position ' + (r.position || 1) : r.stage || 'Thinking' }),
        h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))
      ));
      card.appendChild(h('div', { class: 'bar' }, h('i')));
      updateLive(r);
    } else if (r.status === 'error') {
      card.appendChild(h('p', { class: 'error-text', text: r.error || 'Something went wrong.' }));
      card.appendChild(h('button', { class: 'btn small', text: 'Retry', onclick: function () { reuse(r); submit(); } }));
    } else {
      card.appendChild(buildOutput(r));
    }
    return card;
  }

  function buildOutput(r) {
    var wrap = h('div');
    var view = state.views[r.id] || 'optimized';
    var views = [['optimized', 'Optimized'], ['side', 'Original vs optimized'], ['diff', 'Diff']];
    var tabs = h('div', { class: 'tabs', role: 'tablist' });
    views.forEach(function (v) {
      tabs.appendChild(h('button', { class: 'tab', role: 'tab', 'aria-selected': String(view === v[0]), text: v[1], onclick: function () { state.views[r.id] = v[0]; refreshCard(r); } }));
    });
    wrap.appendChild(tabs);

    if (view === 'optimized') {
      wrap.appendChild(h('pre', { class: 'out', text: r.result }));
    } else {
      var ops = Delta.diff(r.prompt, r.result);
      if (view === 'diff') {
        var pre = h('pre', { class: 'out' });
        pre.appendChild(Delta.renderInline(ops));
        wrap.appendChild(pre);
      } else {
        var s = Delta.renderSide(ops);
        var l = h('pre', { class: 'out' }); l.appendChild(s.left);
        var rr = h('pre', { class: 'out' }); rr.appendChild(s.right);
        wrap.appendChild(h('div', { class: 'side' },
          h('div', null, h('div', { class: 'side-title', text: 'Original' }), l),
          h('div', null, h('div', { class: 'side-title', text: 'Optimized' }), rr)
        ));
      }
    }

    var info = r.info || {};
    var from = info.words ? info.words.from : words(r.prompt);
    var to = info.words ? info.words.to : words(r.result);
    var statText = from + ' → ' + to + ' words (×' + (from ? (to / from).toFixed(1) : '–') + ')' + (info.typeLabel ? ' · ' + info.typeLabel : '') + (r.engine === 'upstream' ? ' · ' + (info.engineLabel || 'AI engine') + (info.passes ? ' · ' + info.passes + (info.passes === 1 ? ' pass' : ' passes') : '') : ' · built-in engine');
    wrap.appendChild(h('div', { class: 'run-foot' },
      h('button', {
        class: 'btn primary small', 'data-shine': true, text: 'Copy compiled prompt',
        onclick: function () { copyText(r.result).then(function () { toast('Compiled prompt copied', 'ok'); }, function () { toast('Copy failed — select the text manually', 'error'); }); }
      }),
      h('span', { class: 'stat', text: statText })
    ));
    (info.warnings || []).forEach(function (w) { wrap.appendChild(h('p', { class: 'report warn', text: w })); });
    var assumed = info.assumptions || [];
    var missing = info.missing || [];
    if (assumed.length || missing.length) {
      var det = h('details', { class: 'assume' }, h('summary', { text: 'What the compiler assumed (' + (assumed.length + missing.length) + ')' }));
      if (assumed.length) { det.appendChild(h('h5', { text: 'Assumptions' })); det.appendChild(h('ul', null, assumed.map(function (a) { return h('li', { text: a }); }))); }
      if (missing.length) { det.appendChild(h('h5', { text: 'Details you did not give' })); det.appendChild(h('ul', null, missing.map(function (a) { return h('li', { text: a }); }))); }
      wrap.appendChild(det);
    }
    return wrap;
  }

  function reuse(r) {
    ui.input.value = r.prompt;
    if (state.models.some(function (m) { return m.id === r.modelId; })) ui.model.value = r.modelId;
    setEffort(r.effort);
    updateComposer();
    ui.input.focus();
  }

  function removeRun(r) {
    if (isOpen(r)) api('/jobs/' + r.id + '/cancel', { method: 'POST' }).catch(function () {});
    state.runs = state.runs.filter(function (x) { return x !== r; });
    persist();
    var c = cardFor(r.id);
    if (c) c.remove();
    if (!state.runs.length) renderRuns();
    ui.clear.hidden = state.runs.length === 0;
  }

  /* ----------------------------------------------------------- drawer / themes */
  function openDrawer(tab) {
    $('#drawer').hidden = false;
    switchTab(tab || 'themes');
  }
  function switchTab(name) {
    $$('#drawer-tabs .tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.getAttribute('data-tab') === name)); });
    $$('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    if (name === 'engine') fillEngine();
  }

  function setTheme(id) {
    document.documentElement.setAttribute('data-theme', id);
    Vault.set('theme', id);
    renderThemes();
  }

  function renderThemes() {
    var current = document.documentElement.getAttribute('data-theme');
    var list = THEMES.slice();
    if (state.custom) list.push({ id: 'custom', name: state.custom.name || 'Custom', desc: 'Generated / imported' });
    $('#themes').textContent = '';
    list.forEach(function (t) {
      $('#themes').appendChild(h('button', {
        class: 'tile', type: 'button', 'data-theme': t.id, 'data-shine': true, 'aria-pressed': String(current === t.id),
        onclick: function () { setTheme(t.id); }
      }, h('b', { text: t.name }), h('small', { text: t.desc }), h('div', { class: 'swatches' }, h('i'), h('i'), h('i'), h('i'))));
    });
  }

  function reportCss(r) {
    var el = $('#css-report');
    var parts = [];
    if (r.ok) parts.push(r.rules + ' rule' + (r.rules === 1 ? '' : 's') + ' active');
    if (r.report && r.report.length) parts = parts.concat(r.report);
    el.textContent = parts.join(' · ');
    el.className = 'report' + (!r.ok ? ' bad' : r.report && r.report.length ? ' warn' : '');
    $('#css-size').textContent = $('#css-editor').value.length + ' B';
  }

  var cssTimer = 0;
  function applyCss(save) {
    var text = $('#css-editor').value;
    var r = Sandbox.apply(text);
    reportCss(r);
    state.css = text;
    if (save) Vault.set('css', text);
  }

  function applyCustomTheme(theme) {
    var vars = Sandbox.setThemeVars(theme.vars);
    state.custom = { name: theme.name, vars: vars };
    Vault.set('custom_theme', state.custom);
  }

  function exportCss() {
    var custom = state.custom;
    var lines = ['/* promptc-theme v1 */'];
    if (custom) {
      lines.push('/* promptc-meta ' + JSON.stringify({ name: custom.name, vars: custom.vars }) + ' */');
      lines.push('[data-theme="custom"] {');
      Object.keys(custom.vars).forEach(function (k) { lines.push('  ' + k + ': ' + custom.vars[k] + ';'); });
      lines.push('}');
    }
    lines.push('/* === user-css === */');
    lines.push($('#css-editor').value);
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/css' });
    var a = h('a', { href: URL.createObjectURL(blob), download: 'promptc-theme-' + (custom ? custom.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'css') + '.css' });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('Theme exported', 'ok');
  }

  function importCss(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var meta = text.match(/\/\* promptc-meta (\{[\s\S]*?\}) \*\//);
      if (meta) {
        try {
          var parsed = JSON.parse(meta[1]);
          var vars = Sandbox.cleanVars(parsed.vars);
          if (Object.keys(vars).length) {
            applyCustomTheme({ name: String(parsed.name || 'Imported').slice(0, 28), vars: vars });
            setTheme('custom');
          }
        } catch (e) { toast('Theme variables could not be read', 'error'); }
      }
      var marker = '/* === user-css === */';
      var idx = text.indexOf(marker);
      var css = idx >= 0 ? text.slice(idx + marker.length).trim() : meta ? '' : text;
      $('#css-editor').value = css;
      applyCss(true);
      toast('Imported ' + file.name, 'ok');
    };
    reader.readAsText(file);
  }

  function generateTheme() {
    var vibe = $('#vibe').value.trim();
    var rep = $('#vibe-report');
    if (!vibe) { rep.textContent = 'Describe a vibe first.'; return; }
    var btn = $('#vibe-go');
    btn.disabled = true;
    rep.className = 'report';
    rep.textContent = 'Designing…';
    var themeBody = { vibe: vibe };
    if (engineReady()) themeBody.engine = engineBody();
    api('/theme', { method: 'POST', body: themeBody }).then(function (t) {
      applyCustomTheme(t);
      setTheme('custom');
      rep.textContent = t.name + ' — ' + t.explain;
      toast('Theme applied', 'ok');
    }).catch(function (e) { rep.className = 'report bad'; rep.textContent = e.message; }).then(function () { btn.disabled = false; });
  }

  /* ------------------------------------------------------------------- modals */
  function openModal(id) { $('#' + id).hidden = false; }
  function closeAny() {
    $$('.modal').forEach(function (m) { m.hidden = true; });
    $('#drawer').hidden = true;
  }

  function list(title, items) {
    if (!items || !items.length) return null;
    var ul = h('ul');
    items.forEach(function (i) { ul.appendChild(h('li', { text: i })); });
    return h('div', null, h('h4', { text: title }), ul);
  }

  function openChanges() {
    var body = $('#changes-body');
    body.textContent = 'Loading…';
    openModal('modal-changes');
    api('/changelog').then(function (d) {
      body.textContent = '';
      d.releases.forEach(function (rel) {
        body.appendChild(h('section', { class: 'release' },
          h('h3', null, 'v' + rel.version, h('small', { text: rel.date + (rel.title ? ' · ' + rel.title : '') })),
          list('Added', rel.added), list('New models', rel.models), list('Changed', rel.changed), list('Fixed', rel.fixed)
        ));
      });
    }).catch(function (e) { body.textContent = 'Could not load the changelog: ' + e.message; });
  }

  function loadSignals() {
    return api('/signals').then(function (d) {
      state.signals = d.signals;
      state.pulse = d.pulse;
      $('#signal-dot').hidden = d.signals.length === 0;
    }).catch(function () {});
  }

  function renderSignals() {
    var body = $('#signals-body');
    body.textContent = '';
    var p = state.pulse || {};
    body.appendChild(h('p', { class: 'hint', text: 'Checked every 14 days · last run: ' + (p.lastRun ? new Date(p.lastRun).toLocaleString() : 'never') + ' · next due: ' + (p.nextDue ? new Date(p.nextDue).toLocaleDateString() : '—') + ' · status: ' + (p.lastStatus || '—') }));
    body.appendChild(h('div', { class: 'row', style: 'margin:8px 0 4px' },
      h('button', { class: 'btn small', text: 'Check now', onclick: function () {
        api('/sentinel/run', { method: 'POST' }).then(function () { toast('Updater started — reopen this panel in a minute', 'ok'); }).catch(function (e) { toast(e.message, 'error'); });
      } })
    ));
    if (!state.signals.length) {
      body.appendChild(h('div', { class: 'empty' }, h('b', { text: 'No new models' }), 'You will be notified here when the updater drafts a new model profile.'));
      return;
    }
    state.signals.forEach(function (s) {
      var notes = s.profile.notes && s.profile.notes.length ? h('ul', null, s.profile.notes.slice(0, 5).map(function (n) { return h('li', { text: n }); })) : null;
      body.appendChild(h('div', { class: 'signal' },
        h('h3', null, s.profile.label, h('span', { class: 'chip', text: s.profile.provider }), h('span', { class: 'chip', text: s.confidence + ' confidence' })),
        h('p', { class: 'hint', text: 'Format family: ' + s.profile.family + ' · found ' + new Date(s.found).toLocaleDateString() }),
        notes,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', text: 'Adopt profile', onclick: function () { decide(s, 'adopt'); } }),
          h('button', { class: 'btn small ghost', text: 'Dismiss', onclick: function () { decide(s, 'dismiss'); } })
        )
      ));
    });
  }

  function decide(s, action) {
    api('/signals/' + s.id + '/' + action, { method: 'POST' }).then(function () {
      toast(action === 'adopt' ? s.profile.label + ' added to the model list' : 'Dismissed', 'ok');
      return Promise.all([loadSignals(), action === 'adopt' ? loadModels() : null]);
    }).then(renderSignals).catch(function (e) { toast(e.message, 'error'); });
  }

  /* --------------------------------------------------------------------- boot */
  function bind() {
    ui.input = $('#input'); ui.model = $('#model'); ui.effort = $('#effort'); ui.effortHint = $('#effort-hint');
    ui.go = $('#go'); ui.count = $('#count'); ui.runs = $('#runs'); ui.clear = $('#clear');

    ui.input.addEventListener('input', updateComposer);
    ui.input.addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); } });
    ui.go.addEventListener('click', submit);
    ui.clear.addEventListener('click', function () {
      state.runs.filter(isOpen).forEach(function (r) { api('/jobs/' + r.id + '/cancel', { method: 'POST' }).catch(function () {}); });
      state.runs = []; persist(); renderRuns();
    });

    $('#btn-changes').addEventListener('click', openChanges);
    $('#btn-signals').addEventListener('click', function () { openModal('modal-signals'); renderSignals(); loadSignals().then(renderSignals); });
    $('#btn-style').addEventListener('click', function () { openDrawer('themes'); renderThemes(); });
    $$('[data-close]').forEach(function (b) { b.addEventListener('click', function () { var t = $('#' + b.getAttribute('data-close')); if (t) t.hidden = true; }); });
    $$('.modal').forEach(function (m) { m.addEventListener('pointerdown', function (e) { if (e.target === m) m.hidden = true; }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAny(); });
    $$('#drawer-tabs .tab').forEach(function (t) { t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); }); });

    var ed = $('#css-editor');
    ed.value = state.css;
    ed.addEventListener('input', function () { clearTimeout(cssTimer); cssTimer = setTimeout(function () { applyCss(true); }, 120); });
    ed.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') { e.preventDefault(); var s = ed.selectionStart; ed.value = ed.value.slice(0, s) + '  ' + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = s + 2; }
    });
    SNIPPETS.forEach(function (s) {
      $('#snippets').appendChild(h('button', { class: 'btn small', type: 'button', text: s[0], onclick: function () { ed.value = (ed.value.trim() ? ed.value.replace(/\s*$/, '\n\n') : '') + s[1] + '\n'; applyCss(true); } }));
    });
    $('#css-export').addEventListener('click', exportCss);
    $('#css-import').addEventListener('click', function () { $('#css-file').click(); });
    $('#css-file').addEventListener('change', function (e) { if (e.target.files[0]) importCss(e.target.files[0]); e.target.value = ''; });
    $('#css-reset').addEventListener('click', function () {
      ed.value = ''; applyCss(true);
      state.custom = null; Vault.del('custom_theme'); Sandbox.setThemeVars({});
      if (document.documentElement.getAttribute('data-theme') === 'custom') setTheme('obsidian'); else renderThemes();
      toast('Appearance reset');
    });

    VIBES.forEach(function (v) { $('#vibes').appendChild(h('button', { class: 'btn small', type: 'button', text: v, onclick: function () { $('#vibe').value = v; generateTheme(); } })); });
    bindEngine();
    $('#vibe-go').addEventListener('click', generateTheme);
    $('#vibe').addEventListener('keydown', function (e) { if (e.key === 'Enter') generateTheme(); });
  }

  function boot() {
    bind();
    buildEffort();
    updateComposer();
    if (state.custom) Sandbox.setThemeVars(state.custom.vars);
    if (document.documentElement.getAttribute('data-theme') === 'custom' && !state.custom) setTheme('obsidian');
    applyCss(false);
    renderThemes();
    renderRuns();
    if (state.runs.some(isOpen)) schedulePoll();
    loadModels().then(updateComposer);
    renderPill();
    loadMeta().then(renderPill);
    loadSignals();
    setInterval(watchSeal, 5000);
    setInterval(loadSignals, 10 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
