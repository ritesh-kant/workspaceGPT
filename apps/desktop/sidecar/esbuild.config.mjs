/**
 * Builds the desktop sidecar and the page bridge.
 *
 *   dist/sidecar/main.js   the extension host code (apps/vscode-extensions/src,
 *                          unchanged) + sidecar/main.ts, with `vscode` aliased
 *                          to sidecar/vscode-compat
 *   dist/bridge/           the shell page (shell.html/js/css) and what it
 *                          injects into each framed view (bridge.js,
 *                          theme.css, skin.css)
 *
 * The extension host resolves its workers, models and native packages from
 * `__dirname` (dist/workers/…, dist/models, dist/node_modules). In dev those
 * are links into apps/vscode-extensions/dist — the extension's own build of
 * the workers, not a second copy — so the extension must be built first
 * (turbo does that: desktop devDepends on workspacegpt-extension). Phase 3
 * packaging copies them instead.
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extDir = path.resolve(root, '../vscode-extensions');
const outSidecar = path.join(root, 'dist/sidecar');
const outBridge = path.join(root, 'dist/bridge');
const watch = process.argv.includes('--watch');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// The analytics shim wraps the real posthog-node; point it at the real file
// so the `posthog-node` alias doesn't swallow its own import.
const extRequire = createRequire(path.join(extDir, 'package.json'));
const realPosthog = extRequire.resolve('posthog-node');

/** @type {esbuild.BuildOptions} */
const sidecar = {
  entryPoints: [path.join(here, 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(outSidecar, 'main.js'),
  sourcemap: true,
  keepNames: true,
  logLevel: 'warning',
  alias: {
    vscode: path.join(here, 'vscode-compat/index.ts'),
    'workspacegpt-extension-host': path.join(extDir, 'src/extension.ts'),
    // Only for the WGPT_DESKTOP_TEST_COMMAND orphan test (the extension's own spawn path).
    'workspacegpt-extension-commands': path.join(extDir, 'src/services/agent/commandTools.ts'),
    'workspacegpt-extension-history': path.join(extDir, 'src/services/historyService.ts'),
    'posthog-node': path.join(here, 'host/posthogShim.ts'),
    'posthog-node-real': realPosthog,
  },
  // Same externals as the extension's own build, plus the sidecar's native keyring and
  // the language server it spawns (resolved from node_modules at run time).
  external: ['@xenova/transformers', 'onnxruntime-node', 'sharp', '@vscode/ripgrep', '@napi-rs/keyring', 'bufferutil', 'utf-8-validate', 'typescript-language-server', 'typescript'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    'process.env.WGPT_DESKTOP_VERSION': JSON.stringify(version),
  },
};

/** @type {esbuild.BuildOptions} */
const bridge = {
  entryPoints: [path.join(root, 'bridge/desktop-bridge.ts')],
  bundle: true,
  platform: 'browser',
  // WKWebView on macOS 12+ / Safari 15 — the oldest engine the Tauri window can get.
  target: ['safari15', 'chrome100'],
  format: 'iife',
  outfile: path.join(outBridge, 'bridge.js'),
  logLevel: 'warning',
};

/** The shell page's script: same browser target as the bridge. */
const shell = { ...bridge, entryPoints: [path.join(root, 'bridge/shell.ts')], outfile: path.join(outBridge, 'shell.js') };

/** Served as-is from dist/bridge. */
const STATIC_BRIDGE_FILES = ['theme.css', 'skin.css', 'shell.css', 'shell.html'];

/** dist/sidecar/{workers,models,node_modules,mcp-server.js} → the extension's build output. */
function linkExtensionDist() {
  for (const name of ['workers', 'models', 'node_modules', 'mcp-server.js']) {
    const target = path.join(extDir, 'dist', name);
    const link = path.join(outSidecar, name);
    const rel = path.relative(outSidecar, target);
    // Leave a correct link alone: a sidecar that is running right now loads
    // workers and native modules through these, and a rebuild under it must
    // not open a window where they don't exist.
    let current;
    try {
      current = fs.readlinkSync(link);
    } catch {
      current = undefined;
    }
    if (current === rel) continue;
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(rel, link);
    if (!fs.existsSync(target)) console.warn(`⚠️  ${target} does not exist yet — build the extension (pnpm --filter workspacegpt-extension build)`);
  }
}

async function run() {
  fs.mkdirSync(outSidecar, { recursive: true });
  fs.mkdirSync(outBridge, { recursive: true });
  for (const name of STATIC_BRIDGE_FILES) fs.copyFileSync(path.join(root, 'bridge', name), path.join(outBridge, name));
  linkExtensionDist();
  if (watch) {
    const contexts = await Promise.all([esbuild.context(sidecar), esbuild.context(bridge), esbuild.context(shell)]);
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('👀 desktop sidecar + bridge watching');
    return;
  }
  await Promise.all([esbuild.build(sidecar), esbuild.build(bridge), esbuild.build(shell)]);
  console.log('✅ desktop sidecar + bridge built → apps/desktop/dist');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
