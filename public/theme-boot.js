// Pre-paint theme resolution. CSP keeps script-src 'self' (no inline
// script), so this tiny same-origin file runs blocking in <head> and kills
// the dark-page flash for light-resolved users before the app bundle
// executes. It mirrors src/theme.ts: a missing, corrupt or unknown stored
// mode means dark (legacy default — the pre-controller UI only ever wrote
// 'light'); 'auto' follows the OS preference. Read-only: it never persists.
// The app module later reconciles everything via theme.apply().
;(function () {
  try {
    var mode = localStorage.getItem('listentopr.theme')
    var dark = true
    if (mode === 'light') {
      dark = false
    } else if (mode === 'auto') {
      // No matchMedia: same fallback as theme.ts resolve() — light.
      dark = !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    var meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', dark ? '#0e1116' : '#f6f7f9')
  } catch (e) {
    // Private mode / storage blocked: stay dark (the CSS :root default).
  }
})()
