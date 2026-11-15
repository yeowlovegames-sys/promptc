/**
 * sandbox.js — the live CSS editor's safety layer.
 *
 * How the sandbox keeps the app stable:
 *  1. Cascade layers: chassis.css declares `@layer lock, skin, user;`. User CSS is wrapped in
 *     `@layer user { ... }`. Structural rules (shell grid, modals, drawer, attribution bar)
 *     live in `lock` and use !important. For !important declarations an EARLIER layer wins,
 *     so user CSS can restyle everything but cannot break layout or hide the seal.
 *  2. Constructable stylesheets: CSS goes through CSSStyleSheet.replaceSync, never into a
 *     <style> tag, so `</style>` tricks and HTML injection are impossible.
 *  3. sanitize(): strips @import/@charset/@namespace/@font-face, every function that can load
 *     a resource (url, image-set, src, image, cross-fade, element, paint), legacy script vectors
 *     (expression, behavior, -moz-binding, javascript:), backslash escapes (used to obfuscate
 *     those names) and rejects CSS whose braces would close the wrapping @layer block.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Sandbox = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX = 60000;

  var ALLOWED_VARS = [
    '--bg', '--bg-2', '--mesh1', '--mesh2', '--mesh3', '--surface', '--surface-2', '--border',
    '--text', '--muted', '--accent', '--accent-2', '--accent-ink', '--ok', '--warn', '--danger',
    '--radius', '--blur', '--font', '--font-mono', '--shine', '--shadow'
  ];
  var VALUE_RX = /^[#a-zA-Z0-9(),.%\s/\-'"+]{1,180}$/;
  var BAD_RX = /(url|expression|javascript|import|@|;|\{|\}|<|>|\\)/i;

  function cleanVars(input) {
    var out = {};
    if (!input || typeof input !== 'object') return out;
    ALLOWED_VARS.forEach(function (k) {
      var v = input[k];
      if (typeof v === 'string' && VALUE_RX.test(v) && !BAD_RX.test(v)) out[k] = v.trim();
    });
    return out;
  }

  /** walks the css like a browser would (skipping strings) and returns brace depth info */
  function braceScan(css) {
    var depth = 0;
    var quote = '';
    for (var i = 0; i < css.length; i++) {
      var c = css[i];
      if (quote) {
        if (c === quote) quote = '';
        else if (c === '\n') quote = ''; // unterminated string ends at newline
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth < 0) return { depth: depth, escaped: true };
      }
    }
    return { depth: depth, escaped: false };
  }

  function sanitize(input) {
    var css = String(input == null ? '' : input);
    var report = [];
    if (css.length > MAX) {
      css = css.slice(0, MAX);
      report.push('Truncated to 60 KB.');
    }
    css = css.replace(/\/\*[\s\S]*?\*\//g, ''); // comments first so `u/**/rl(` cannot hide
    if (/\\/.test(css)) {
      css = css.replace(/\\/g, '');
      report.push('Removed backslash escapes (not allowed in the sandbox).');
    }
    var strip = [
      [/@import[^;{}]*;?/gi, '@import'],
      [/@charset[^;{}]*;?/gi, '@charset'],
      [/@namespace[^;{}]*;?/gi, '@namespace'],
      [/@font-face\s*\{[^}]*\}/gi, '@font-face'],
      [/<\/?style[^>]*>/gi, '<style> tags'],
      [/javascript\s*:/gi, 'javascript:'],
      [/-moz-binding\s*:[^;}]*/gi, '-moz-binding'],
      [/behavior\s*:[^;}]*/gi, 'behavior']
    ];
    strip.forEach(function (r) {
      var n = (css.match(r[0]) || []).length;
      if (n) {
        css = css.replace(r[0], '');
        report.push('Removed ' + n + '× ' + r[1] + ' (blocked).');
      }
    });
    var fnRx = /(?<![\w-])(?:-webkit-)?(?:url|image-set|cross-fade|image|src|element|paint|expression)\s*\(/gi;
    var fnCount = (css.match(fnRx) || []).length;
    if (fnCount) {
      css = css.replace(fnRx, 'blocked(');
      report.push('Blocked ' + fnCount + '× resource-loading function (url, image-set, …).');
    }
    var scan = braceScan(css);
    if (scan.escaped) {
      return { css: '', report: ['Unbalanced "}" — the CSS would escape the sandbox, so nothing was applied.'], ok: false };
    }
    if (scan.depth > 0) {
      css += '\n' + new Array(scan.depth + 1).join('}');
      report.push('Auto-closed ' + scan.depth + ' open block(s).');
    }
    return { css: css, report: report, ok: true };
  }

  /* ---------------- browser-only part ---------------- */

  var userSheet = null;
  var themeSheet = null;

  function ensure() {
    if (userSheet) return;
    userSheet = new CSSStyleSheet();
    themeSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat([themeSheet, userSheet]);
  }

  /** applies user css inside @layer user; returns {ok, report, rules} */
  function apply(css) {
    ensure();
    var r = sanitize(css);
    userSheet.replaceSync('@layer user {\n' + r.css + '\n}');
    var layer = userSheet.cssRules[0];
    r.rules = layer && layer.cssRules ? layer.cssRules.length : 0;
    return r;
  }

  /** applies the custom (AI / imported) theme variables into the `skin` layer */
  function setThemeVars(vars) {
    ensure();
    var clean = cleanVars(vars);
    var body = Object.keys(clean).map(function (k) { return k + ':' + clean[k] + ';'; }).join('');
    themeSheet.replaceSync('@layer skin { [data-theme="custom"] {' + body + '} }');
    return clean;
  }

  return { sanitize: sanitize, apply: apply, setThemeVars: setThemeVars, cleanVars: cleanVars, ALLOWED_VARS: ALLOWED_VARS };
});
