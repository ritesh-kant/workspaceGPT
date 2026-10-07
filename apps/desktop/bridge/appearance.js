// Runs in the shell and every view before styles load so the saved choice
// applies on the first paint. All pages share the loopback origin's storage.
(function () {
  // The port changes every launch, so localStorage starts empty: restore the
  // choice the host saved (server.ts serves it as __wgptAppearance) before the
  // first apply, which also lets the settings select show it.
  try {
    if (!localStorage.getItem('workspacegpt.appearance') && window.__wgptAppearance) {
      localStorage.setItem('workspacegpt.appearance', window.__wgptAppearance);
    }
  } catch { /* storage unavailable */ }
  function apply() {
    let choice = null;
    try { choice = localStorage.getItem('workspacegpt.appearance'); } catch { /* storage unavailable */ }
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.dataset.wgptTheme = choice;
    } else {
      delete document.documentElement.dataset.wgptTheme;
    }
    window.dispatchEvent(new Event('wgpt-theme-change'));
  }
  apply();
  window.addEventListener('storage', (event) => {
    if (event.key === 'workspacegpt.appearance') apply();
  });
  window.addEventListener('wgpt-appearance-change', () => {
    apply();
    let choice = '';
    try { choice = localStorage.getItem('workspacegpt.appearance') || ''; } catch { /* storage unavailable */ }
    fetch('/__desktop/appearance', { method: 'POST', body: choice }).catch(() => undefined);
  });
})();
