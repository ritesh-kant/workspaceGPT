#!/usr/bin/env node
/**
 * One release build for one target (Phase 3): stage the runtime, run
 * `tauri build` with the release config, then check what came out.
 *
 *   node scripts/build-release.mjs [--target darwin-arm64] [--skip-stage] [--bundles app,dmg]
 *
 * Needs TAURI_SIGNING_PRIVATE_KEY (path or key text) for the updater
 * signatures; locally it falls back to ~/.tauri/workspacegpt-desktop-updater.key.
 * Prints the bundle paths; desktop-publish.yml uploads them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget } from './fetch-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const target = argOf('target') ?? hostTarget();
const [platform] = target.split('-');

/** target → Rust triple (tauri build --target). */
const TRIPLE = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
};
/** Per platform: what users download (DMG / NSIS / AppImage) plus what the updater applies. */
const DEFAULT_BUNDLES = { darwin: 'app,dmg', win32: 'nsis', linux: 'appimage' };
const bundles = argOf('bundles') ?? DEFAULT_BUNDLES[platform];
if (!TRIPLE[target]) throw new Error(`unsupported target ${target}`);

const run = (cmd, args, env = {}) => {
  console.log(`[release] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status ?? r.signal})`);
};

if (!process.argv.includes('--skip-stage')) run(process.execPath, ['scripts/stage-runtime.mjs', '--target', target]);

const env = { PATH: `${path.join(os.homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}` };
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const local = path.join(os.homedir(), '.tauri', 'workspacegpt-desktop-updater.key');
  if (!fs.existsSync(local)) throw new Error('TAURI_SIGNING_PRIVATE_KEY is not set and ~/.tauri/workspacegpt-desktop-updater.key does not exist');
  env.TAURI_SIGNING_PRIVATE_KEY = local;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
}
const tauri = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
run(tauri, ['build', '--config', 'src-tauri/tauri.release.conf.json', '--target', TRIPLE[target], '--bundles', bundles], env);

// ── Check the output ──────────────────────────────────────────────────────
const bundleDir = path.join(root, 'src-tauri/target', TRIPLE[target], 'release/bundle');
const found = [];
const walk = (d) => {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name);
    if (/\.(dmg|app\.tar\.gz|sig|exe|AppImage|msi|zip)$/.test(e.name) || e.name.endsWith('.app')) found.push(p);
    else if (e.isDirectory()) walk(p);
  }
};
walk(bundleDir);

if (platform === 'darwin') {
  const app = found.find((p) => p.endsWith('.app'));
  if (!app) throw new Error(`no .app under ${bundleDir}`);
  const runtime = path.join(app, 'Contents/Resources/runtime');
  if (!fs.existsSync(path.join(runtime, 'sidecar/main.js'))) throw new Error(`${app} has no Contents/Resources/runtime/sidecar/main.js`);
  // --deep --strict also verifies every nested signature the outer seal covers.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`[release] codesign --verify --deep --strict: ok (${app})`);
}
if (platform === 'win32') {
  // The NSIS installer is also the updater's bundle: tauri signs it (`-setup.exe.sig`).
  const setup = found.find((p) => p.endsWith('-setup.exe'));
  if (!setup) throw new Error(`no NSIS -setup.exe under ${bundleDir}`);
  if (!fs.existsSync(`${setup}.sig`)) throw new Error(`${setup} has no .sig (is TAURI_SIGNING_PRIVATE_KEY set?)`);
  for (const f of ['node.exe', 'sidecar/main.js']) {
    if (!fs.existsSync(path.join(root, 'dist/runtime', f))) throw new Error(`the staged runtime has no ${f}`);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/runtime/manifest.json'), 'utf8'));
console.log(`[release] ${target} v${manifest.app} (extension ${manifest.extension}, node ${manifest.node}):`);
for (const p of found) console.log(`  ${path.relative(root, p)}  ${fs.statSync(p).isFile() ? `${(fs.statSync(p).size / 1024 / 1024).toFixed(0)} MB` : ''}`);
