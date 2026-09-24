#!/usr/bin/env node
/**
 * pnpm --filter desktop dev:headless [-- --workspace <dir> --no-open ...]
 *
 * Builds what's missing, then runs the sidecar under plain Node and opens the
 * chat in your default browser. Any other flags go to the sidecar (see
 * sidecar/main.ts). Ctrl-C stops it and everything it started.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.resolve(root, '../vscode-extensions');

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!fs.existsSync(path.join(extDir, 'dist/workers')) || !fs.existsSync(path.join(extDir, 'webview/dist/index.html'))) {
  console.log('→ building the extension first (webview + host + workers)…');
  run('pnpm', ['--filter', 'workspacegpt-extension', 'build'], root);
}
run(process.execPath, [path.join(root, 'sidecar/esbuild.config.mjs')], root);

const passthrough = process.argv.slice(2).filter((a) => a !== '--');
const noOpen = passthrough.includes('--no-open');
const sidecarArgs = passthrough.filter((a) => a !== '--no-open');
if (!noOpen && !sidecarArgs.includes('--open')) sidecarArgs.push('--open');

const child = spawn(process.execPath, [path.join(root, 'dist/sidecar/main.js'), ...sidecarArgs], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => {
  // pnpm only reports "exit status N"; say what actually happened.
  if (signal) {
    console.error(`[desktop] sidecar killed by ${signal}`);
    process.exit(128 + (os.constants.signals[signal] ?? 0));
  }
  if (code) console.error(`[desktop] sidecar exited with code ${code}${code === 75 ? ' (profile already in use — see above)' : ''}`);
  process.exit(code ?? 0);
});
