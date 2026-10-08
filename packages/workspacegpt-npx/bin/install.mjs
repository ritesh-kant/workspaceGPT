#!/usr/bin/env node
// `npx workspacegpt` installs WorkspaceGPT Desktop. It carries no installer
// logic of its own: it runs the release's install.sh (macOS) or install.ps1
// (Windows), the same scripts behind the curl / irm one-liners, so the two
// can't drift. Those scripts verify the SHA-256 and signature.
import { spawnSync } from 'node:child_process';

const BASE = process.env.WGPT_RELEASE_BASE || 'https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest';

let cmd;
let args;
let input;
if (process.platform === 'darwin') {
  // Fetched here, not `curl | sh`: a failed download would leave sh with an empty script and exit 0.
  const res = await fetch(`${BASE}/install.sh`).catch((e) => ({ ok: false, statusText: e.cause?.code || e.message }));
  if (!res.ok) {
    console.error(`workspacegpt: could not download the installer (${res.status ?? ''} ${res.statusText})`);
    process.exit(1);
  }
  input = await res.text();
  cmd = 'sh';
  args = ['-s'];
} else if (process.platform === 'win32') {
  cmd = 'powershell';
  args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${BASE}/install.ps1 | iex`];
} else {
  console.error('WorkspaceGPT Desktop is available for macOS and Windows. Linux builds are not available yet.');
  process.exit(1);
}

const r = spawnSync(cmd, args, input === undefined ? { stdio: 'inherit' } : { input, stdio: ['pipe', 'inherit', 'inherit'] });
if (r.error) {
  console.error(`workspacegpt: could not run ${cmd}: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
