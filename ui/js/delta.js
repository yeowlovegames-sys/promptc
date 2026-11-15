/**
 * delta.js — word-level diff (LCS) used by the "Original vs Optimized" views.
 * Pure function `diff` works in node (selftest) and the browser; render helpers need the DOM.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Delta = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_CELLS = 6000000;

  function tokens(s) {
    return String(s).match(/\s+|[^\s]+/g) || [];
  }

  /** @returns {{t:'eq'|'add'|'del', v:string}[]} */
  function diff(a, b) {
    var A = tokens(a);
    var B = tokens(b);
    if (A.length * B.length > MAX_CELLS) {
      // too large for a word-level table: fall back to line level
      A = String(a).split(/(\n)/);
      B = String(b).split(/(\n)/);
      if (A.length * B.length > MAX_CELLS) return [{ t: 'del', v: String(a) }, { t: 'add', v: String(b) }];
    }
    var n = A.length;
    var m = B.length;
    var w = m + 1;
    var dp = new Uint32Array((n + 1) * w);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    var ops = [];
    var x = 0;
    var y = 0;
    function push(t, v) {
      var last = ops[ops.length - 1];
      if (last && last.t === t) last.v += v;
      else ops.push({ t: t, v: v });
    }
    while (x < n && y < m) {
      if (A[x] === B[y]) { push('eq', A[x]); x++; y++; }
      else if (dp[(x + 1) * w + y] >= dp[x * w + y + 1]) { push('del', A[x]); x++; }
      else { push('add', B[y]); y++; }
    }
    while (x < n) push('del', A[x++]);
    while (y < m) push('add', B[y++]);
    return ops;
  }

  function span(cls, text) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
  }

  /** inline view: kept words plain, additions green, removals struck through */
  function renderInline(ops) {
    var f = document.createDocumentFragment();
    ops.forEach(function (o) {
      f.appendChild(span(o.t === 'add' ? 'd-add' : o.t === 'del' ? 'd-del' : '', o.v));
    });
    return f;
  }

  /** side-by-side: left = original (removed words marked), right = optimized (added words marked) */
  function renderSide(ops) {
    var left = document.createDocumentFragment();
    var right = document.createDocumentFragment();
    ops.forEach(function (o) {
      if (o.t === 'eq') { left.appendChild(span('', o.v)); right.appendChild(span('', o.v)); }
      else if (o.t === 'del') left.appendChild(span('d-del', o.v));
      else right.appendChild(span('d-add', o.v));
    });
    return { left: left, right: right };
  }

  return { diff: diff, renderInline: renderInline, renderSide: renderSide };
});
