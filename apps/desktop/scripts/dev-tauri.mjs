#!/usr/bin/env node
/**
 * pnpm --filter desktop dev
 *
 * Builds what's missing (extension → sidecar), then runs `tauri dev`, which
 * compiles src-tauri and opens the native window. The shell spawns the
 * sidecar with the same Node that runs this script.
 *
 * Env passed through to the sidecar: WGPT_DESKTOP_DATA_DIR (profile dir),
 * WGPT_DESKTOP_TRACE_WORKERS=1, WGPT_DESKTOP_ANALYTICS=1.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.resolve(root, '../vscode-extensions');
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!fs.existsSync(path.join(cargoBin, 'cargo')) && spawnSync('cargo', ['--version']).status !== 0) {
  console.error('Rust is not installed — see https://rustup.rs (Phase 1 needs cargo).');
  process.exit(1);
}
if (!fs.existsSync(path.join(extDir, 'dist/workers')) || !fs.existsSync(path.join(extDir, 'webview/dist/index.html'))) {
  console.log('→ building the extension first (webview + host + workers)…');
  run('pnpm', ['--filter', 'workspacegpt-extension', 'build']);
}
run(process.execPath, [path.join(root, 'sidecar/esbuild.config.mjs')]);

const env = {
  ...process.env,
  PATH: `${cargoBin}${path.delimiter}${process.env.PATH}`,
  WGPT_NODE: process.execPath,
  WGPT_SIDECAR_MAIN: path.join(root, 'dist/sidecar/main.js'),
};
const tauri = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const child = spawn(tauri, ['dev', ...process.argv.slice(2).filter((a) => a !== '--')], { cwd: root, stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
