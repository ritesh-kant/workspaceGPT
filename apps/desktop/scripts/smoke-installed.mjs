#!/usr/bin/env node
/**
 * Smoke test for an INSTALLED release build (CI runs it after installing the
 * Windows NSIS build; it also runs against a macOS .app):
 *
 *   node scripts/smoke-installed.mjs --exe "<install dir>\WorkspaceGPT.exe"
 *   node scripts/smoke-installed.mjs --exe /path/WorkspaceGPT.app/Contents/MacOS/WorkspaceGPT
 *
 * 1. Launches the app on a scratch profile. The profile has analytics off, no
 *    browser launches, and the real OS keychain.
 * 2. Waits for the sidecar to serve its page (WGPT_DESKTOP_DEBUG_TOKEN_FILE),
 *    then fetches it.
 * 3. Checks that the sidecar runs on the bundled Node, not whatever `node` is
 *    on PATH.
 * 4. Starts a long command through the agent's own run_command path
 *    (WGPT_DESKTOP_TEST_COMMAND).
 * 5. Force-kills the shell (TerminateProcess / SIGKILL, so no quit handler
 *    runs) and checks that nothing started from the install directory
 *    survives. That is the Windows Job Object (src-tauri/src/sidecar.rs) and
 *    the sidecar's stdin watchdog.
 */
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const i = process.argv.indexOf('--exe');
const exe = i > 0 ? path.resolve(process.argv[i + 1]) : undefined;
if (!exe || !fs.existsSync(exe)) throw new Error(`--exe <installed WorkspaceGPT binary> is required (got ${exe})`);
const win = process.platform === 'win32';
// Everything the app ships lives under here (install dir on Windows, the .app on macOS).
const installRoot = win ? path.dirname(exe) : path.resolve(exe, '../../..');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Processes whose executable is inside the install root: [{ pid, path, cmd }]. */
function ours() {
  // This script (and the shell that ran it) name the install path in their argv.
  return scan().filter((p) => p.pid !== process.pid && !p.cmd.includes('smoke-installed.mjs'));
}

function scan() {
  if (win) {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8' });
    const rows = [].concat(JSON.parse(ps.stdout || '[]'));
    const all = rows.map((r) => ({ pid: r.ProcessId, path: r.ExecutablePath || '', cmd: r.CommandLine || '' }));
    const root = installRoot.toLowerCase();
    return all.filter((r) => r.path.toLowerCase().startsWith(root) || isTestCommand(r.cmd));
  }
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return ps.stdout.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [pid, ...rest] = l.split(/\s+/);
    return { pid: Number(pid), path: rest[0] ?? '', cmd: rest.join(' ') };
  }).filter((r) => r.cmd.includes(installRoot) || isTestCommand(r.cmd));
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-smoke-'));
const tokenFile = path.join(scratch, 'token.txt');
const workspace = path.join(scratch, 'workspace');
fs.mkdirSync(workspace);
// A command that outlives the test unless something kills it.
// 297 is the marker: every process in the chain (the shell and ping/sleep) shows it.
const longCommand = win ? 'ping -n 297 127.0.0.1' : 'sleep 297';
const isTestCommand = (cmd) => /-n 297 127\.0\.0\.1|sleep 297/.test(cmd);

const before = ours();
check('nothing from the install is running before the test', before.length === 0, before.map((p) => p.pid).join(' '));

const shell = spawn(exe, [], {
  cwd: workspace,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WGPT_DESKTOP_DATA_DIR: path.join(scratch, 'profile'),
    WGPT_DESKTOP_DEBUG_TOKEN_FILE: tokenFile,
    WGPT_DESKTOP_NO_BROWSER: '1',
    WGPT_DESKTOP_ANALYTICS: '0',
    WGPT_DESKTOP_TEST_COMMAND: longCommand,
  },
});
let log = '';
shell.stdout.on('data', (d) => (log += d));
shell.stderr.on('data', (d) => (log += d));

let link;
for (let t = 0; t < 180 && !link; t++) {
  await sleep(1000);
  if (fs.existsSync(tokenFile)) link = fs.readFileSync(tokenFile, 'utf8').trim();
  if (shell.exitCode !== null) break;
}
check('the sidecar served its page', !!link, link ? new URL(link).origin : `app exited ${shell.exitCode}`);

if (link) {
  const res = await fetch(new URL(link).origin + '/').catch((e) => ({ ok: false, status: String(e) }));
  const html = res.ok ? await res.text() : '';
  check('GET / answers with the shell page', res.ok && /<html/i.test(html), `HTTP ${res.status}`);

  await sleep(5000); // let the test command start
  const running = ours();
  const node = running.find((p) => /node(\.exe)?$/i.test(p.path) || /[\\/]runtime[\\/]node(\.exe)?\b/i.test(p.cmd));
  check('the sidecar runs on the bundled Node', !!node, node ? node.path || node.cmd.slice(0, 120) : running.map((p) => p.path).join(', '));
  const cmd = running.find((p) => isTestCommand(p.cmd));
  check('the test command is running', !!cmd, cmd ? `pid ${cmd.pid}` : 'not found');
}

// Force-kill the shell alone, not its tree: no quit handler runs.
if (win) spawnSync('taskkill', ['/PID', String(shell.pid), '/F'], { stdio: 'ignore' });
else process.kill(shell.pid, 'SIGKILL');

let left = ours();
for (let t = 0; t < 20 && left.length; t++) {
  await sleep(1000);
  left = ours();
}
check('nothing survives a force-killed shell', left.length === 0, left.map((p) => `${p.pid} ${p.path || p.cmd.slice(0, 80)}`).join('; '));

for (const p of left) {
  try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
}
if (failed) console.log(`\n--- app output ---\n${log.slice(-4000)}`);
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
