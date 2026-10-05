/**
 * The user's integrated terminal: real PTYs (node-pty) behind a socket of
 * their own, drawn by xterm.js in the shell page (bridge/terminal.ts).
 *
 * Deliberately separate from the agent's command runner (commandTools.ts):
 * that one uses pipes so it gets exit codes, timeouts and approval cards.
 * Nothing here is reachable by the model — no tool reads or writes these
 * sessions — so a terminal can't be used to get around the agent's gates.
 *
 * Sessions are keyed by an id the page chooses, and keep a bounded scrollback,
 * so a page reload or socket reconnect re-attaches to the same shell instead
 * of orphaning it. Every PTY is killed with the sidecar (a PTY child is its
 * own session leader, so Tauri's group kill does not reach it).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebSocket } from 'ws';

export type TermToHost =
  | { t: 'open'; id: string; cols: number; rows: number }
  | { t: 'in'; id: string; d: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'close'; id: string };

export type TermToPage =
  | { t: 'out'; id: string; d: string }
  | { t: 'exit'; id: string; code: number | null }
  | { t: 'error'; id: string; message: string };

interface PtyLike {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface Session {
  id: string;
  pty: PtyLike;
  /** Bounded replay for a page that re-attaches. */
  scrollback: string;
  exited: boolean;
}

const MAX_SESSIONS = 8;
const SCROLLBACK_CHARS = 200_000;
const MAX_INPUT_CHARS = 1_000_000;

const clampDim = (n: unknown, fallback: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 2), 500) : fallback;

/**
 * node-pty's spawn-helper is a prebuilt that package managers can unpack
 * without the executable bit; posix_spawnp then fails with no useful message.
 */
function ensureHelperExecutable(ptyDir: string): void {
  if (process.platform === 'win32') return;
  const prebuilds = path.join(ptyDir, 'prebuilds');
  try {
    for (const dir of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, dir, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch {
    /* no prebuilds dir: node-pty was built from source and has its own helper */
  }
}

export interface TerminalHost {
  attach(ws: WebSocket): void;
  dispose(): void;
  readonly sessionCount: number;
}

export function createTerminalHost(getCwd: () => string | undefined, log: (line: string) => void): TerminalHost {
  const sessions = new Map<string, Session>();
  let page: WebSocket | undefined;
  let ptyModule: typeof import('node-pty') | undefined;
  let ptyError: string | undefined;

  const loadPty = () => {
    if (ptyModule || ptyError) return ptyModule;
    try {
      // External in esbuild.config.mjs (native module), resolved from node_modules at run time.
      const resolved = require.resolve('node-pty');
      ensureHelperExecutable(path.resolve(path.dirname(resolved), '..'));
      ptyModule = require('node-pty');
    } catch (e) {
      ptyError = e instanceof Error ? e.message : String(e);
      log(`[desktop] terminal unavailable: ${ptyError}`);
    }
    return ptyModule;
  };

  const send = (frame: TermToPage) => {
    if (page && page.readyState === page.OPEN) page.send(JSON.stringify(frame));
  };

  // Coalesce bursts (a `cat` of a big file) into one frame per tick.
  const pending = new Map<string, string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const queueOut = (id: string, d: string) => {
    pending.set(id, (pending.get(id) ?? '') + d);
    flushTimer ??= setTimeout(() => {
      flushTimer = undefined;
      for (const [sid, data] of pending) send({ t: 'out', id: sid, d: data });
      pending.clear();
    }, 8);
  };

  const shellFor = (): [string, string[]] => {
    if (process.platform === 'win32') return [process.env.COMSPEC || 'powershell.exe', []];
    return [process.env.SHELL || '/bin/zsh', ['-l']];
  };

  const open = (id: string, cols: number, rows: number) => {
    const existing = sessions.get(id);
    if (existing) {
      // A re-attach (reload, reconnect): replay what the shell has printed.
      if (existing.scrollback) send({ t: 'out', id, d: existing.scrollback });
      if (existing.exited) send({ t: 'exit', id, code: null });
      else existing.pty.resize(cols, rows);
      return;
    }
    if ([...sessions.values()].filter((s) => !s.exited).length >= MAX_SESSIONS) {
      send({ t: 'error', id, message: `${MAX_SESSIONS} terminals are already open — close one first.` });
      return;
    }
    const pty = loadPty();
    if (!pty) {
      send({ t: 'error', id, message: `The terminal could not start: ${ptyError}` });
      return;
    }
    const [file, args] = shellFor();
    const cwd = getCwd();
    try {
      const proc = pty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'WorkspaceGPT' } as Record<string, string>,
      });
      const session: Session = { id, pty: proc, scrollback: '', exited: false };
      sessions.set(id, session);
      proc.onData((d) => {
        session.scrollback = (session.scrollback + d).slice(-SCROLLBACK_CHARS);
        queueOut(id, d);
      });
      proc.onExit(({ exitCode }) => {
        session.exited = true;
        send({ t: 'exit', id, code: exitCode });
      });
    } catch (e) {
      send({ t: 'error', id, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const close = (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    if (!s.exited) {
      try {
        s.pty.kill();
      } catch {
        /* already gone */
      }
    }
  };

  const onFrame = (raw: string) => {
    let f: TermToHost;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (!f || typeof f.id !== 'string' || f.id.length > 64) return;
    switch (f.t) {
      case 'open':
        open(f.id, clampDim(f.cols, 80), clampDim(f.rows, 24));
        break;
      case 'in':
        if (typeof f.d === 'string' && f.d.length <= MAX_INPUT_CHARS) {
          const s = sessions.get(f.id);
          if (s && !s.exited) s.pty.write(f.d);
        }
        break;
      case 'resize': {
        const s = sessions.get(f.id);
        if (s && !s.exited) s.pty.resize(clampDim(f.cols, 80), clampDim(f.rows, 24));
        break;
      }
      case 'close':
        close(f.id);
        break;
    }
  };

  return {
    attach(ws) {
      // One shell page at a time; the newer socket wins (as for the view sockets).
      page?.close();
      page = ws;
      ws.on('message', (data) => onFrame(data.toString()));
      ws.on('close', () => {
        if (page === ws) page = undefined;
      });
    },
    dispose() {
      if (flushTimer) clearTimeout(flushTimer);
      for (const id of [...sessions.keys()]) close(id);
      page?.close();
    },
    get sessionCount() {
      return sessions.size;
    },
  };
}
