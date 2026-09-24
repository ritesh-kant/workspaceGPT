/**
 * One sidecar per profile (data dir).
 *
 * Every sidecar keeps the profile's state.json in memory and writes the whole
 * file back, so two on the same profile silently overwrite each other — seen
 * in practice: a stale instance's save reset the settings to defaults. The
 * second sidecar now refuses to start instead.
 *
 * The lock is a file holding the owner's pid. A lock whose pid is gone (the
 * owner was killed -9, or the machine rebooted) is stale and taken over.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const PROFILE_IN_USE_PREFIX = '@@WGPT_PROFILE_IN_USE@@ ';

export class ProfileInUseError extends Error {
  constructor(
    readonly dir: string,
    readonly pid: number
  ) {
    super(`another WorkspaceGPT Desktop (pid ${pid}) is already using ${dir}`);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the profile's lock or throws ProfileInUseError. Released when this process exits. */
export function acquireProfileLock(dir: string): void {
  const file = path.join(dir, 'sidecar.lock');
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      process.on('exit', () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let owner = 0;
    try {
      owner = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid) || 0;
    } catch {
      /* unreadable: treat as stale */
    }
    if (owner && owner !== process.pid && alive(owner)) throw new ProfileInUseError(dir, owner);
    fs.rmSync(file, { force: true });
  }
  throw new Error(`could not take the profile lock ${file}`);
}
