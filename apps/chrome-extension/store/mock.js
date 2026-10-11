// Stands in for the chrome.* APIs so the real built side panel can render store screenshots.
// Scene comes from the URL hash: #chat | #welcome | #history
const scene = location.hash.slice(1) || 'chat';
const store = { browserBridgeStatus: { connected: true, at: Date.now() } };
const ls = [];
const noop = { addListener() {}, removeListener() {} };
const ANSWER =
  '**Release process** — this page explains how we ship to production:\n\n' +
  '1. Merge to `release` after review\n2. Run the **release pipeline**\n3. Tag it and announce in #releases\n\n' +
  'Two things to watch: config sync must finish before the hotfix window, and rollbacks need a second approval.\n\n' +
  '**Sources**\n- [Release process](https://wiki.example.com/release)\n- [Hotfix runbook](https://wiki.example.com/hotfix)';
const ago = (m) => Date.now() - m * 60000;
if (scene === 'history') {
  const msg = (q) => [{ role: 'user', content: q }, { role: 'assistant', content: 'Answer.' }];
  store.wgptChats = [
    ['How do we deploy to staging?', 4], ['Who owns the payments service?', 95], ['What changed in the checkout docs this week?', 60 * 26],
    ['Summarise the open sprint tickets for the web team', 60 * 52], ['Where is the on-call runbook for the API gateway?', 60 * 24 * 4], ['Explain our feature flag naming rules', 60 * 24 * 9],
  ].map(([q, m], i) => ({ id: 'c' + i, title: q, updatedAt: ago(m), messages: msg(q) }));
}
window.chrome = {
  tabs: { query: async () => [{ id: 7, title: 'Release process – Platform Wiki', url: 'https://wiki.example.com/release', active: true }], onActivated: noop, onUpdated: noop },
  windows: { onFocusChanged: noop },
  storage: { local: { get: async () => JSON.parse(JSON.stringify(store)), set: async (o) => { Object.assign(store, o); ls.forEach((f) => f({}, 'local')); } }, onChanged: { addListener: (f) => ls.push(f), removeListener: () => {} } },
  runtime: {
    getManifest: () => ({ version: '0.4.0' }),
    connect: () => {
      const L = [];
      return {
        onMessage: { addListener: (f) => L.push(f) }, onDisconnect: { addListener: () => {} }, disconnect() {},
        postMessage(m) { if (m.method === 'chat') setTimeout(() => { L.forEach((f) => f({ id: m.id, kind: 'chunk', text: ANSWER })); L.forEach((f) => f({ id: m.id, kind: 'done' })); }, 50); },
      };
    },
  },
};
window.addEventListener('load', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    await sleep(500);
    if (scene === 'chat') {
      const t = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, 'Summarise this page');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      document.querySelector('button[title="Send"]').click();
    }
    if (scene === 'history') document.querySelector('button[title="History"]').click();
    await sleep(700);
    document.documentElement.dataset.ready = '1';
  })();
});
