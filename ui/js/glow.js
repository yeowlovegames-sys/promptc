/**
 * glow.js — cursor-tracking spotlight/shine.
 * Any element with [data-shine] gets --mx/--my (cursor position inside it) and a `.lit` class
 * while the pointer is over it or one of its children. The actual look lives in chassis.css.
 */
(function () {
  'use strict';
  var lit = new Set();
  var frame = 0;
  var last = null;

  function update() {
    frame = 0;
    if (!last) return;
    var next = new Set();
    var node = last.target && last.target.closest ? last.target.closest('[data-shine]') : null;
    while (node) {
      next.add(node);
      var r = node.getBoundingClientRect();
      node.style.setProperty('--mx', last.clientX - r.left + 'px');
      node.style.setProperty('--my', last.clientY - r.top + 'px');
      node.classList.add('lit');
      node = node.parentElement ? node.parentElement.closest('[data-shine]') : null;
    }
    lit.forEach(function (n) { if (!next.has(n)) n.classList.remove('lit'); });
    lit = next;
  }

  document.addEventListener('pointermove', function (e) {
    last = e;
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });

  document.documentElement.addEventListener('pointerleave', function () {
    lit.forEach(function (n) { n.classList.remove('lit'); });
    lit.clear();
    last = null;
  });
})();
