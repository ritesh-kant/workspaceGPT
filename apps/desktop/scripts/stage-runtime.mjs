#!/usr/bin/env node
/**
 * Assembles dist/runtime/ — everything the packaged app runs besides the Rust
 * shell — for one target (Phase 3). tauri.release.conf.json bundles it as the
 * app's `runtime/` resource, and src-tauri/src/sidecar.rs starts
 * `runtime/node runtime/sidecar/main.js` from there.
 *
 *   node scripts/stage-runtime.mjs [--target darwin-arm64] [--skip-build]
 *
 * Layout (the sidecar resolves each of these relative to itself, as in dev):
 *   runtime/node                     pinned Node (scripts/fetch-node.mjs), its own signature kept
 *   runtime/sidecar/main.js          the sidecar, NODE_ENV=production (analytics on)
 *   runtime/sidecar/workers/ models/ mcp-server.js      the extension's build output
 *   runtime/sidecar/node_modules/    the extension's native deps, pruned to this target
 *                                    (its own VSCODE_TARGET filter), plus the desktop's:
 *                                    @napi-rs/keyring + this target's binary, typescript,
 *                                    typescript-language-server
 *   runtime/bridge/                  the shell page and view bridge
 *   runtime/extension/               what the extension host reads by path: package.json,
 *                                    resources/, webview/dist/, dist/mcp-server.js
 *   runtime/manifest.json            versions, for diagnostics and the release checks
 *
 * On macOS every Mach-O file except node is ad-hoc signed (challenge #8): Apple
 * Silicon refuses to run unsigned code, and node's hardened runtime has
 * disable-library-validation, so it loads ad-hoc-signed addons.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fetchNode, hostTarget, NODE_VERSION } from './fetch-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.resolve(root, '../vscode-extensions');
const out = path.join(root, 'dist/runtime');

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const target = argOf('target') ?? hostTarget();
const skipBuild = process.argv.includes('--skip-build');
const [platform, arch] = target.split('-');

/** @napi-rs/keyring's binary package for a target. */
const KEYRING_PACKAGE = {
  'darwin-arm64': '@napi-rs/keyring-darwin-arm64',
  'darwin-x64': '@napi-rs/keyring-darwin-x64',
  'linux-x64': '@napi-rs/keyring-linux-x64-gnu',
  'linux-arm64': '@napi-rs/keyring-linux-arm64-gnu',
  'win32-x64': '@napi-rs/keyring-win32-x64-msvc',
  'win32-arm64': '@napi-rs/keyring-win32-arm64-msvc',
};
if (!KEYRING_PACKAGE[target]) throw new Error(`unsupported target ${target}`);

const run = (cmd, args, cwd, env = {}) => {
  console.log(`[stage] $ ${cmd} ${args.join(' ')}  (in ${path.relative(path.resolve(root, '../..'), cwd) || '.'}${Object.keys(env).length ? `, ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.signal})`);
};

const pkgDir = (fromDir, name) => fs.realpathSync(path.dirname(createRequire(path.join(fromDir, 'package.json')).resolve(`${name}/package.json`)));

/** Copy, following symlinks (pnpm's store, dev links), skipping source maps. */
const copy = (src, dest) => {
  fs.cpSync(src, dest, { recursive: true, dereference: true, filter: (s) => !s.endsWith('.map') });
};

// ── 1. Builds ─────────────────────────────────────────────────────────────
if (!skipBuild) {
  // The extension's build copies the MCP server's bundle but doesn't build it
  // (a clean checkout, like CI, has none).
  run('pnpm', ['--filter', '@workspace-gpt/mcp-server', 'run', 'build'], root);
  // The extension's own release build (vscode:prepublish), pruned to this target.
  run('pnpm', ['run', 'download-models'], extDir);
  run('pnpm', ['run', 'build'], extDir, { NODE_ENV: 'production', VSCODE_TARGET: target });
  run('node', ['sidecar/esbuild.config.mjs'], root, { NODE_ENV: 'production' });
}

// ── 2. Stage ──────────────────────────────────────────────────────────────
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'sidecar'), { recursive: true });

const node = await fetchNode(target);
fs.copyFileSync(node, path.join(out, path.basename(node)));
if (platform !== 'win32') fs.chmodSync(path.join(out, path.basename(node)), 0o755);

fs.copyFileSync(path.join(root, 'dist/sidecar/main.js'), path.join(out, 'sidecar/main.js'));
fs.copyFileSync(path.join(root, 'dist/sidecar/browser-relay.js'), path.join(out, 'sidecar/browser-relay.js'));
for (const name of ['workers', 'models', 'node_modules', 'mcp-server.js']) {
  copy(path.join(extDir, 'dist', name), path.join(out, 'sidecar', name));
}
// The extension build prunes onnxruntime-node and ripgrep only when VSCODE_TARGET
// is set; a --skip-build stage of a dev build would ship all six platforms.
const ortPlatforms = path.join(out, 'sidecar/node_modules/onnxruntime-node/bin/napi-v3');
if (fs.existsSync(ortPlatforms)) {
  for (const p of fs.readdirSync(ortPlatforms)) {
    if (p !== platform) fs.rmSync(path.join(ortPlatforms, p), { recursive: true, force: true });
    else for (const a of fs.readdirSync(path.join(ortPlatforms, p))) if (a !== arch) fs.rmSync(path.join(ortPlatforms, p, a), { recursive: true, force: true });
  }
}
const vscodeScope = path.join(out, 'sidecar/node_modules/@vscode');
for (const p of fs.existsSync(vscodeScope) ? fs.readdirSync(vscodeScope) : []) {
  if (p.startsWith('ripgrep-') && p !== `ripgrep-${target}`) fs.rmSync(path.join(vscodeScope, p), { recursive: true, force: true });
}

// The desktop's own run-time packages (esbuild externals in sidecar/esbuild.config.mjs).
const modules = path.join(out, 'sidecar/node_modules');
const keyringDir = pkgDir(root, '@napi-rs/keyring');
const desktopPackages = [
  ['@napi-rs/keyring', keyringDir],
  [KEYRING_PACKAGE[target], pkgDir(keyringDir, KEYRING_PACKAGE[target])],
  ['typescript', pkgDir(root, 'typescript')],
  ['typescript-language-server', pkgDir(root, 'typescript-language-server')],
];
for (const [name, dir] of desktopPackages) copy(dir, path.join(modules, name));

copy(path.join(root, 'dist/bridge'), path.join(out, 'bridge'));

const extOut = path.join(out, 'extension');
fs.mkdirSync(path.join(extOut, 'dist'), { recursive: true });
fs.copyFileSync(path.join(extDir, 'package.json'), path.join(extOut, 'package.json'));
copy(path.join(extDir, 'resources'), path.join(extOut, 'resources'));
copy(path.join(extDir, 'webview/dist'), path.join(extOut, 'webview/dist'));
fs.copyFileSync(path.join(extDir, 'dist/mcp-server.js'), path.join(extOut, 'dist/mcp-server.js'));

// ── 3. Sign (macOS) ───────────────────────────────────────────────────────
const MACHO = new Set(['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'feedface', 'cefaedfe']);
const isMachO = (file) => {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(4);
  const n = fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  return n === 4 && MACHO.has(buf.toString('hex'));
};
const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
};
const files = walk(out);
let signed = 0;
if (platform === 'darwin') {
  if (process.platform !== 'darwin') throw new Error('a darwin runtime has to be staged on macOS (codesign)');
  for (const f of files) {
    if (f === path.join(out, 'node') || !isMachO(f)) continue;
    execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', f], { stdio: 'pipe' });
    signed++;
  }
}

// ── 4. Manifest + report ──────────────────────────────────────────────────
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tauriVersion = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
if (version !== tauriVersion) throw new Error(`apps/desktop/package.json version ${version} ≠ tauri.conf.json ${tauriVersion}; the updater compares the latter`);
const extVersion = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8')).version;
fs.writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify({ app: version, extension: extVersion, node: NODE_VERSION, target, stagedAt: new Date().toISOString() }, null, 2) + '\n'
);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`[stage] dist/runtime for ${target}: ${files.length} files, ${(bytes / 1024 / 1024).toFixed(0)} MB${platform === 'darwin' ? `, ${signed} Mach-O files ad-hoc signed (node keeps its own signature)` : ''}`);
