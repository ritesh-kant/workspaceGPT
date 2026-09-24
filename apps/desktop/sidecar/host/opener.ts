/**
 * System integrations the compat module delegates to: browser, the user's
 * editor, the clipboard. All argv-based (no shell strings), so a URL or path
 * can never be interpreted as a command.
 */
import { spawn, spawnSync } from 'node:child_process';

function launch(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', (err) => {
        console.error(`[desktop] ${cmd} failed:`, err.message);
        resolve(false);
      });
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch (err) {
      console.error(`[desktop] ${cmd} failed:`, err);
      resolve(false);
    }
  });
}

function systemOpen(target: string): Promise<boolean> {
  if (process.platform === 'darwin') return launch('open', [target]);
  if (process.platform === 'win32') return launch('rundll32', ['url.dll,FileProtocolHandler', target]);
  return launch('xdg-open', [target]);
}

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * `vscode.env.openExternal`. VS Code would open any scheme; the desktop only
 * opens web and mail links — every caller in the extension (OAuth pages,
 * PR links, chat links) is one of those, and handing `open` an arbitrary
 * scheme or a file: URL from model output would be a local-action hole.
 */
export async function openExternal(target: string): Promise<boolean> {
  let scheme: string;
  try {
    scheme = new URL(target).protocol;
  } catch {
    console.warn(`[desktop] openExternal: not a URL, refused: ${target.slice(0, 200)}`);
    return false;
  }
  if (!EXTERNAL_SCHEMES.has(scheme)) {
    console.warn(`[desktop] openExternal: "${scheme}" links are not opened by the desktop app`);
    return false;
  }
  // Automation/CI: print the link instead of launching a browser.
  if (process.env.WGPT_DESKTOP_NO_BROWSER === '1') {
    console.log(`[desktop] openExternal (not launched, WGPT_DESKTOP_NO_BROWSER=1): ${target}`);
    return true;
  }
  return systemOpen(target);
}

function onPath(cmd: string): boolean {
  const probe = process.platform === 'win32' ? spawnSync('where', [cmd]) : spawnSync('/bin/sh', ['-c', 'command -v "$0"', cmd]);
  return probe.status === 0;
}

/**
 * "Open this file" hands off to the user's editor (the desktop has none).
 * Order: $WGPT_EDITOR (a command that takes `file:line`), then VS Code's /
 * Cursor's CLI (`-g file:line` jumps to the line), then the OS default app.
 */
export async function openInEditor(file: string, line?: number): Promise<void> {
  const target = line ? `${file}:${line}` : file;
  const custom = process.env.WGPT_EDITOR;
  if (custom) {
    await launch(custom, [target]);
    return;
  }
  for (const cli of ['code', 'cursor']) {
    if (onPath(cli)) {
      await launch(cli, ['-g', target]);
      return;
    }
  }
  await systemOpen(file);
}

function pipeTo(cmd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin!.end(input);
  });
}

export function clipboardWrite(text: string): Promise<void> {
  if (process.platform === 'darwin') return pipeTo('pbcopy', [], text);
  if (process.platform === 'win32') return pipeTo('clip', [], text);
  return pipeTo(process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip', process.env.WAYLAND_DISPLAY ? [] : ['-selection', 'clipboard'], text);
}

export async function clipboardRead(): Promise<string> {
  const r =
    process.platform === 'darwin'
      ? spawnSync('pbpaste')
      : process.platform === 'win32'
        ? spawnSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'])
        : spawnSync(process.env.WAYLAND_DISPLAY ? 'wl-paste' : 'xclip', process.env.WAYLAND_DISPLAY ? [] : ['-selection', 'clipboard', '-o']);
  if (r.status !== 0) throw new Error('clipboard read failed');
  return String(r.stdout);
}
