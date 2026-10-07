// Runs in the shell and every view before styles load so the saved choice
// applies on the first paint. All pages share the loopback origin's storage.
(function () {
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
  window.addEventListener('wgpt-appearance-change', apply);
})();
