// The colour theme: Auto (follow the device), Light or Dark. And the layout:
// classic, or the beta "simple mode" (Theme.ui / Theme.setUi).
//
// Loaded in <head>, before the stylesheet, so the page paints in the right
// theme from the first frame (no white flash in dark mode). The choice is
// per device, in localStorage; Auto stores nothing and follows the OS, live.
//
//   Theme.choice()        'auto' | 'light' | 'dark'
//   Theme.current()       'light' | 'dark', what's showing
//   Theme.set(choice)
//   Theme.onChange(fn)    fn('light' | 'dark') when what's showing changes
//
// Everything themed is CSS: colours are tokens on :root, overridden under
// :root[data-theme="dark"]. Even the SVG drawings carry both palettes, so a
// switch repaints everything, open sheets included, without re-rendering.
(function () {
  var KEY = 'trickledown.theme';
  var BG = { light: '#EDF1F2', dark: '#0C171D' };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var listeners = [];
  var current = null;

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  var choice = stored();

  function apply() {
    var t = choice === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : choice;
    var root = document.documentElement;
    if (t === current) return;
    var was = current;
    current = t;
    // Switching shouldn't animate every transition on the page at once.
    if (was) root.classList.add('theme-swap');
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BG[t]);
    if (was) {
      setTimeout(function () { root.classList.remove('theme-swap'); }, 60);
      listeners.forEach(function (f) { try { f(t); } catch (e) { /* a listener's problem, not the theme's */ } });
    }
  }
  apply();

  // The layout: 'classic', or the simpler 'beta' one (Account → Simple mode).
  // Also per device, also set before anything paints: <html data-ui="beta">.
  var UI_KEY = 'trickledown.ui';
  function storedUi() { try { return localStorage.getItem(UI_KEY) === 'beta' ? 'beta' : 'classic'; } catch (e) { return 'classic'; } }
  var ui = storedUi();
  function applyUi() { if (ui === 'beta') document.documentElement.setAttribute('data-ui', 'beta'); else document.documentElement.removeAttribute('data-ui'); }
  applyUi();

  if (mq) {
    var follow = function () { if (choice === 'auto') apply(); };
    if (mq.addEventListener) mq.addEventListener('change', follow); else if (mq.addListener) mq.addListener(follow);
  }
  // Changed in another tab.
  window.addEventListener('storage', function (e) { if (e.key === KEY) { choice = stored(); apply(); } if (e.key === UI_KEY) { ui = storedUi(); applyUi(); } });

  window.Theme = {
    choice: function () { return choice; },
    current: function () { return current; },
    dark: function () { return current === 'dark'; },
    set: function (c) {
      choice = c === 'light' || c === 'dark' ? c : 'auto';
      try { if (choice === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch (e) { /* private mode: still applies for this visit */ }
      apply();
    },
    onChange: function (f) { listeners.push(f); },
    ui: function () { return ui; },
    setUi: function (v) {
      ui = v === 'beta' ? 'beta' : 'classic';
      try { if (ui === 'beta') localStorage.setItem(UI_KEY, 'beta'); else localStorage.removeItem(UI_KEY); } catch (e) { /* this visit only */ }
      applyUi();
    },
  };
})();
