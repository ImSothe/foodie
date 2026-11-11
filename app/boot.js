/* Minimal boot: loads before anything else, with NO inline code in the HTML (so the CSP can forbid it).
   1) Resolve the theme before the first paint (no flash of the wrong one).
   2) Anti-clickjacking: if another site embeds the app in a frame, it stays hidden. */
(function () {
  'use strict';
  var root = document.documentElement;
  var pref = 'auto';
  try { pref = localStorage.getItem('fd.theme') || 'auto'; } catch (e) { /* storage blocked */ }
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    var dark = pref === 'dark' || (pref !== 'light' && !!(mq && mq.matches));
    root.dataset.theme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0A0A0C' : '#F3F3F5');
  }
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  if (mq && mq.addEventListener) mq.addEventListener('change', apply);
  window.fdTheme = {
    get: function () { return pref; },
    set: function (p) {
      pref = p === 'light' || p === 'dark' ? p : 'auto';
      try { localStorage.setItem('fd.theme', pref); } catch (e) { /* storage blocked */ }
      apply();
    },
  };
  if (window.top !== window.self) {
    root.hidden = true;
    try { window.top.location = window.self.location; } catch (e) { /* blocked: stays hidden */ }
  }
})();
