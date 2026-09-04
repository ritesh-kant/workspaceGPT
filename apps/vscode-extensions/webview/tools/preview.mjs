/**
 * Serves the built webview in a plain browser so UI changes can be LOOKED AT
 * without launching VS Code.
 *
 * The webview only renders inside a VS Code webview host, which means a UI
 * change is normally unverifiable short of packaging the extension and opening
 * a window. This supplies the two things the bundle actually needs — a mock
 * `acquireVsCodeApi` and the `--vscode-*` theme variables — and nothing else,
 * so what renders is the real component tree against the real CSS.
 *
 *   pnpm --filter ... exec vite build     # or: cd webview && npx vite build
 *   node webview/tools/preview.mjs        # then open http://127.0.0.1:7391
 *
 * Two globals are injected for driving it from the devtools console:
 *
 *   __host(msg)  dispatches a host→webview message, e.g.
 *                __host({ type: 'error-chat', message: '503 …',
 *                         resumable: { steps: 18, writesApplied: 2 } })
 *   __posted     every webview→host message, in order, for asserting what a
 *                click actually sent
 *
 * The app gates on settings, so the first thing to send is always:
 *
 *   __host({ type: 'get-global-state-response', key: 'settings',
 *            state: { config: { onboardingCompleted: true, mode: 'local' } } })
 *   __host({ type: 'get-global-state-response', key: 'model',
 *            state: { selectedModelProvider: { provider: 'OpenRouter',
 *                     selectedModel: 'x', apiKey: 'x' } } })
 *   __host({ type: 'workspace-path', path: '/repo' })
 *
 * Sending a settings response with no `state` first puts the app into
 * onboarding and it will not come back out — reload and send the good one.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, '../dist');
const PORT = Number(process.env.PORT ?? 7391);

/** Minimal stand-in for the webview host: the API object plus a theme. */
const INJECTED = `
<script>
  const posted = [];
  window.__posted = posted;
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => { posted.push(m); console.log('[webview -> host]', JSON.stringify(m).slice(0, 300)); },
    getState: () => ({}),
    setState: () => {},
  });
  window.__host = (m) => window.dispatchEvent(new MessageEvent('message', { data: m }));
</script>
<style>
  /* Dark+ values. Only the variables the components actually reference. */
  :root {
    --vscode-editor-background: #1f1f1f;
    --vscode-editor-foreground: #cccccc;
    --vscode-foreground: #cccccc;
    --vscode-panel-border: #3c3c3c;
    --vscode-focusBorder: #0078d4;
    --vscode-button-background: #0078d4;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #026ec1;
    --vscode-button-secondaryBackground: #313131;
    --vscode-button-secondaryForeground: #cccccc;
    --vscode-button-secondaryHoverBackground: #3c3c3c;
    --vscode-inputValidation-errorBackground: #5a1d1d;
    --vscode-inputValidation-errorBorder: #be1100;
    --vscode-inputValidation-errorForeground: #f0d3d3;
    --vscode-input-background: #313131;
    --vscode-input-foreground: #cccccc;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-textLink-foreground: #4daafc;
  }
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
</style>
`;

const MIME = {
  js: 'text/javascript',
  css: 'text/css',
  html: 'text/html',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error(`No build at ${DIST}. Run \`npx vite build\` in webview/ first.`);
  process.exit(1);
}

http
  .createServer((req, res) => {
    const requested = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = requested === '/' ? '/index.html' : requested;
    const abs = path.join(DIST, file);
    // Serve only from DIST — this binds to localhost, but a traversal bug in a
    // dev server is still a traversal bug.
    if (!abs.startsWith(DIST) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    let body = fs.readFileSync(abs);
    if (file === '/index.html') {
      body = Buffer.from(String(body).replace('</head>', `${INJECTED}</head>`));
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).slice(1)] ?? 'application/octet-stream' });
    res.end(body);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`webview preview → http://127.0.0.1:${PORT}`));
