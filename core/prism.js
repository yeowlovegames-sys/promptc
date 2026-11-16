'use strict';
/**
 * prism.js — AI theme generator.
 *
 * Turns a plain-English vibe ("calm forest glass", "neon cyber terminal") into a set of
 * CSS custom properties. Uses the upstream LLM when configured, otherwise a local
 * keyword -> HSL palette engine. Output is always validated against a whitelist so
 * a generated theme can never inject arbitrary CSS.
 */
const uplink = require('./uplink');

const ALLOWED = [
  '--bg', '--bg-2', '--mesh1', '--mesh2', '--mesh3', '--surface', '--surface-2', '--border',
  '--text', '--muted', '--accent', '--accent-2', '--accent-ink', '--ok', '--warn', '--danger',
  '--radius', '--blur', '--font', '--font-mono', '--shine', '--shadow'
];

const VALUE_RX = /^[#a-zA-Z0-9(),.%\s/\-'"+]{1,180}$/;
const BAD_RX = /(url|expression|javascript|import|@|;|\{|\}|<|>|\\)/i;

function cleanVars(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of ALLOWED) {
    const v = input[key];
    if (typeof v === 'string' && VALUE_RX.test(v) && !BAD_RX.test(v)) out[key] = v.trim();
  }
  return out;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const H = (h, s, l, a) => {
  const base = `${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 0, 100))}%`;
  return a == null ? `hsl(${base})` : `hsl(${base} / ${+a.toFixed(2)})`;
};

const COLORS = [
  [/\b(red|crimson|ruby|lava|fire|blood|scarlet)\b/, 2],
  [/\b(orange|sunset|amber|autumn|tangerine|warm|sunrise|coral|peach)\b/, 24],
  [/\b(gold|golden|yellow|honey|sun|sunny|lemon|luxury|royal|brass)\b/, 44],
  [/\b(lime|green|forest|nature|jungle|matrix|emerald|moss|mint|sage|hacker|terminal)\b/, 145],
  [/\b(teal|cyan|aqua|ocean|sea|lagoon|arctic|ice|cool|turquoise)\b/, 188],
  [/\b(blue|sky|navy|midnight|cobalt|deep|azure)\b/, 218],
  [/\b(indigo|violet|purple|lavender|galaxy|space|dream|cosmic|twilight)\b/, 262],
  [/\b(magenta|pink|rose|sakura|candy|blossom|synthwave|vaporwave|fuchsia)\b/, 320]
];

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function build(o) {
  const dark = o.mode === 'dark';
  const { hue, sat: S, mesh, radius } = o;
  const h2 = hue + 40;
  const h3 = hue + 180;
  const glass = o.glass;
  return {
    '--bg': dark ? H(hue, S * 0.45, 6) : H(hue, S * 0.5, 97),
    '--bg-2': dark ? H(hue, S * 0.4, 10) : H(hue, S * 0.45, 93),
    '--mesh1': H(hue, S, dark ? 38 : 82, mesh * 0.55),
    '--mesh2': H(h2, S, dark ? 34 : 86, mesh * 0.45),
    '--mesh3': H(h3, S * 0.9, dark ? 30 : 88, mesh * 0.35),
    '--surface': dark ? H(hue, S * 0.35, 14, glass ? 0.42 : 0.72) : H(hue, S * 0.4, 100, glass ? 0.5 : 0.82),
    '--surface-2': dark ? H(hue, S * 0.35, 20, 0.7) : H(hue, S * 0.4, 95, 0.9),
    '--border': dark ? H(hue, S * 0.6, 75, 0.14) : H(hue, S * 0.5, 30, 0.14),
    '--text': dark ? H(hue, 20, 94) : H(hue, 35, 12),
    '--muted': dark ? H(hue, 12, 66) : H(hue, 15, 40),
    '--accent': H(hue, S, dark ? (o.neon ? 58 : 66) : 46),
    '--accent-2': H(h2, S, dark ? 68 : 50),
    '--accent-ink': dark ? H(hue, 40, 8) : '#ffffff',
    '--ok': H(150, 70, dark ? 55 : 36),
    '--warn': H(38, 95, dark ? 58 : 44),
    '--danger': H(0, 85, dark ? 64 : 48),
    '--radius': `${radius}px`,
    '--blur': glass ? '22px' : '0px',
    '--font': o.mono
      ? 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
      : o.serif
        ? 'ui-serif, Georgia, "Times New Roman", serif'
        : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    '--font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    '--shine': H(hue, S, dark ? 70 : 50, dark ? 0.22 : 0.16),
    '--shadow': dark ? '0 10px 40px hsl(0 0% 0% / 0.45)' : `0 10px 30px hsl(${Math.round(hue)} 30% 30% / 0.14)`
  };
}

function titleCase(s) {
  return s.split(/\s+/).slice(0, 3).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').slice(0, 28);
}

function localTheme(vibe) {
  const text = vibe.toLowerCase();
  const found = [];
  let hue = null;
  for (const [rx, h] of COLORS) {
    if (rx.test(text)) {
      if (hue === null) hue = h;
      found.push(h);
    }
  }
  const opts = { hue: hue === null ? hashHue(text) : hue, mode: 'dark', sat: 78, mesh: 0.7, radius: 16, glass: false, mono: false, serif: false, neon: false };
  const notes = [];
  if (/\b(light|bright|paper|day|clean|white|pastel|airy|soft|cream|morning|daylight)\b/.test(text)) { opts.mode = 'light'; notes.push('light mode'); }
  if (/\b(dark|night|midnight|noir|black|moody|nocturnal|space)\b/.test(text)) { opts.mode = 'dark'; }
  if (/\b(glass|frost|frosted|translucent|blur|crystal|acrylic)\b/.test(text)) { opts.glass = true; opts.mesh = 0.95; notes.push('glassmorphism'); }
  if (/\b(neon|cyber|cyberpunk|synth|synthwave|vaporwave|matrix|hacker|terminal|retro-?futur\w*)\b/.test(text)) { opts.neon = true; opts.sat = 100; opts.mesh = 0.9; opts.mono = /\b(terminal|hacker|matrix|cyber)\b/.test(text); notes.push('neon glow'); }
  if (/\b(minimal|mono|monochrome|zen|quiet|calm|muted|subtle)\b/.test(text)) { opts.sat = Math.min(opts.sat, 28); opts.mesh = 0.35; notes.push('low saturation'); }
  if (/\b(pastel|candy|cute|kawaii)\b/.test(text)) { opts.sat = 70; opts.mode = 'light'; opts.radius = 22; }
  if (/\b(luxury|royal|elegant|classic|editorial|serif|vintage)\b/.test(text)) { opts.serif = true; opts.radius = 8; notes.push('serif type'); }
  if (/\b(sharp|brutal|brutalist|industrial|square|boxy)\b/.test(text)) { opts.radius = 2; notes.push('sharp corners'); }
  if (/\b(round|bubbly|friendly|playful|soft|cute|pill)\b/.test(text)) { opts.radius = 24; notes.push('round corners'); }
  if (/\b(mesh|gradient|aurora|vivid|vibrant|colorful|colourful)\b/.test(text)) { opts.mesh = 1; opts.sat = Math.max(opts.sat, 85); notes.push('strong mesh gradient'); }
  const vars = build(opts);
  return {
    name: titleCase(vibe) || 'Custom',
    mode: opts.mode,
    vars,
    engine: 'local',
    explain: `Hue ${Math.round(opts.hue)}, ${opts.mode} palette${notes.length ? ' + ' + notes.join(', ') : ''}.`
  };
}

async function generate(vibe, engine) {
  const text = String(vibe || '').trim().slice(0, 200);
  if (!text) throw new Error('Describe a vibe first.');
  if (uplink.enabled(engine)) {
    try {
      const system = [
        'You design UI themes. Reply with ONLY a JSON object: {"name": string, "mode": "dark"|"light", "vars": {...}}.',
        `vars may only use these keys: ${ALLOWED.join(', ')}.`,
        'Values must be valid CSS colors (hsl/hex/rgb with alpha where useful), lengths, or font stacks. No url(), no semicolons, no braces.',
        '--mesh1..3 are translucent colors used for a background mesh gradient. --shine is a translucent spotlight color. Ensure strong text contrast.'
      ].join('\n');
      const raw = await uplink.chat({ system, user: text, engine, timeoutMs: 45000 });
      const a = raw.indexOf('{');
      const b = raw.lastIndexOf('}');
      const parsed = JSON.parse(raw.slice(a, b + 1));
      const vars = cleanVars(parsed.vars);
      if (Object.keys(vars).length >= 10) {
        const base = localTheme(text).vars;
        return { name: String(parsed.name || titleCase(text)).slice(0, 28), mode: parsed.mode === 'light' ? 'light' : 'dark', vars: { ...base, ...vars }, engine: 'upstream', explain: 'Generated by your AI engine.' };
      }
    } catch (err) {
      console.warn('[prism] ai engine failed, using local engine:', err.message);
    }
  }
  return localTheme(text);
}

module.exports = { generate, cleanVars, ALLOWED, localTheme };
