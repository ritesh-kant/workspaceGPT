/**
 * Apps opened from Finder/Dock get launchd's minimal PATH (/usr/bin:/bin:…),
 * so Homebrew/nvm/pnpm/gh are invisible and run_checks fails quietly
 * (challenge #7). At startup, ask the user's login shell for its PATH and
 * merge it in front of ours. Bounded: a slow or interactive rc file must not
 * hold up the app.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';

const START = '__WGPT_PATH_START__';
const END = '__WGPT_PATH_END__';

export interface ShellPathResult {
  shell: string;
  merged: boolean;
  added: string[];
  error?: string;
  path: string;
}

export function mergeLoginShellPath(timeoutMs = 3000): Promise<ShellPathResult> {
  if (process.platform === 'win32') {
    return Promise.resolve({ shell: '', merged: false, added: [], path: process.env.PATH ?? '' });
  }
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      const m = out.indexOf(START);
      const e = out.indexOf(END, m);
      if (m === -1 || e === -1) {
        resolve({ shell, merged: false, added: [], error: error ?? 'no PATH in shell output', path: process.env.PATH ?? '' });
        return;
      }
      const shellPath = out.slice(m + START.length, e).split(path.delimiter).filter(Boolean);
      const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
      const added = shellPath.filter((p) => !current.includes(p));
      const merged = [...new Set([...shellPath, ...current])];
      process.env.PATH = merged.join(path.delimiter);
      resolve({ shell, merged: true, added, path: process.env.PATH });
    };
    let child;
    try {
      // -i -l: the same rc files a Terminal window runs; printf between markers
      // so motd/prompt noise from those files can't corrupt the value.
      child = spawn(shell, ['-ilc', `printf '${START}%s${END}' "$PATH"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, WGPT_SHELL_PROBE: '1' },
        detached: true, // own session/group: an interactive shell must not grab our terminal
      });
    } catch (err: any) {
      finish(err?.message ?? String(err));
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      finish(`timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    child.stdout!.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(err.message);
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}
