/**
 * vault.js — localStorage wrapper (history, theme, css). Falls back to memory if storage is blocked.
 * Loaded synchronously in <head> so the saved theme is applied before first paint.
 */
(function (root) {
  'use strict';
  var NS = 'promptc:';
  var mem = {};
  var ok = (function () {
    try {
      localStorage.setItem(NS + 't', '1');
      localStorage.removeItem(NS + 't');
      return true;
    } catch (e) {
      return false;
    }
  })();

  function get(key, fallback) {
    try {
      var raw = ok ? localStorage.getItem(NS + key) : mem[key];
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      var s = JSON.stringify(value);
      if (ok) localStorage.setItem(NS + key, s);
      else mem[key] = s;
      return true;
    } catch (e) {
      return false; // quota exceeded
    }
  }

  function del(key) {
    try {
      if (ok) localStorage.removeItem(NS + key);
      else delete mem[key];
    } catch (e) { /* ignore */ }
  }

  root.Vault = { get: get, set: set, del: del };

  try {
    var t = get('theme', 'obsidian');
    document.documentElement.setAttribute('data-theme', /^[a-z0-9-]+$/.test(t) ? t : 'obsidian');
  } catch (e) { /* ignore */ }
})(window);
