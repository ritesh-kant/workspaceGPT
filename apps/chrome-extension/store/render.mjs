/**
 * Renders the Chrome Web Store images (screenshots 1280x800, small tile 440x280) from the REAL built
 * side panel (../dist) with mock data. Run `pnpm build` first, then: node store/render.mjs
 * Needs Google Chrome (CHROME env var to point elsewhere) and puppeteer-core from the repo's node_modules.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const out = path.join(here, 'images');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const require = createRequire(import.meta.url);
const puppeteer = require(
  fs.readdirSync(path.join(here, '../../../node_modules/.pnpm')).filter((d) => d.startsWith('puppeteer-core@')).map((d) => path.join(here, '../../../node_modules/.pnpm', d, 'node_modules/puppeteer-core'))[0],
);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  let file;
  if (url === '/stage.html' || url === '/mock.js') file = path.join(here, url);
  else file = path.join(dist, url.replace(/^\/panel/, '') || '/');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(file);
  if (url.endsWith('sidepanel.html')) body = Buffer.from(body.toString().replace('<head>', '<head><script src="/mock.js"></script>'));
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}).listen(0);
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const shots = [
  { name: '1-ask-from-any-tab', scene: 'chat', w: 1280, h: 800 },
  { name: '2-your-knowledge', scene: 'welcome', w: 1280, h: 800 },
  { name: '3-history', scene: 'history', w: 1280, h: 800 },
  { name: 'promo-small-440x280', scene: 'tile', w: 440, h: 280 },
];
for (const s of shots) {
  const page = await browser.newPage();
  await page.setViewport({ width: s.w, height: s.h, deviceScaleFactor: 1 });
  await page.goto(`${base}/stage.html?scene=${s.scene}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.dataset.ready === '1', { timeout: 15000 });
  await page.screenshot({ path: path.join(out, `${s.name}.png`) });
  await page.close();
  console.log('✓', s.name);
}
await browser.close();
server.close();
