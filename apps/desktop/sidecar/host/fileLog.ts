/**
 * A persistent log for the packaged app, where stderr goes nowhere.
 *
 * `installFileLog` tees console.* into `logs/sidecar.log` (rotated at 2 MB,
 * three rotated copies kept). Only console output is written, never the shell protocol
 * lines on stdout (those can carry paths and notification text).
 *
 * `running.json` is the abnormal-exit marker: written at start, refreshed every
 * 30 s with the RSS, removed by a clean shutdown. Finding it at the next start
 * means the previous sidecar was killed, ran out of memory or crashed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { format } from 'node:util';

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;
const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function rotate(file: string): void {
  try {
    for (let i = KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* a log must never take the app down */
  }
}

export function installFileLog(logDir: string): string {
  const file = path.join(logDir, 'sidecar.log');
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* first run */
  }
  if (size > MAX_BYTES) {
    rotate(file);
    size = 0;
  }
  const write = (level: string, args: unknown[]) => {
    try {
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${format(...(args as [unknown]))}\n`;
      if (size > MAX_BYTES) {
        rotate(file);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += line.length;
    } catch {
      /* disk full, folder gone: keep running */
    }
  };
  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      write(level, args);
      original(...args);
    };
  }
  return file;
}

export interface PreviousRun {
  startedAt: number;
  lastSeenAt: number;
  rssBytes: number;
  version: string;
}

/** Records this run and returns the previous one if it never shut down cleanly. */
export function startRunMarker(logDir: string, version: string): { previous?: PreviousRun; clear: () => void } {
  const file = path.join(logDir, 'running.json');
  let previous: PreviousRun | undefined;
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof old?.startedAt === 'number') {
      previous = { startedAt: old.startedAt, lastSeenAt: old.lastSeenAt ?? old.startedAt, rssBytes: old.rssBytes ?? 0, version: String(old.version ?? '') };
    }
  } catch {
    /* none, or unreadable: nothing to report */
  }
  const startedAt = Date.now();
  const touch = () => {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt, lastSeenAt: Date.now(), rssBytes: process.memoryUsage().rss, version }));
    } catch {
      /* best effort */
    }
  };
  touch();
  setInterval(touch, 30_000).unref();
  return {
    previous,
    clear: () => {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Error class + a hash of the stack with paths, numbers and message stripped: groups crashes without carrying content. */
export function describeError(err: unknown): { errorName: string; stackHash: string } {
  const e = err as { name?: string; stack?: string } | undefined;
  const errorName = typeof e?.name === 'string' ? e.name.slice(0, 40) : typeof err;
  const frames = String(e?.stack ?? '')
    .split('\n')
    .filter((l) => /^\s+at /.test(l))
    .slice(0, 8)
    .map((l) => l.replace(/\(.*[\\/]/, '(').replace(/^\s+at\s+.*[\\/]/, 'at ').replace(/:\d+(:\d+)?\)?$/, ''));
  return { errorName, stackHash: crypto.createHash('sha1').update(errorName + frames.join('|')).digest('hex').slice(0, 12) };
}
