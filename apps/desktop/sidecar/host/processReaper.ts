/**
 * Nothing the sidecar starts may outlive it (challenge #6).
 *
 * Three layers, because each misses something:
 *  1. Tauri spawns the sidecar as a process-group leader and kills the group
 *     on quit — that covers forked search workers, which inherit the group.
 *  2. `run_command` / `run_checks` children are spawned `detached` (their own
 *     group, so tree-kill can take the whole test runner down) — which also
 *     takes them OUT of our group. This module tracks every child the
 *     extension host spawns and kills each one's group on shutdown.
 *  3. If the parent dies without warning (force-quit), stdin closes; main.ts
 *     treats that as shutdown and runs this reaper.
 *
 * It wraps child_process.spawn/fork on the module object. esbuild compiles
 * the extension's `import { spawn } from 'child_process'` to a property read
 * at call time, so calls made after install() go through the wrapper.
 */
import * as cp from 'node:child_process';

interface Tracked {
  child: cp.ChildProcess;
  detached: boolean;
  what: string;
}

const live = new Map<number, Tracked>();

function track(child: cp.ChildProcess, detached: boolean, what: string): cp.ChildProcess {
  const pid = child.pid;
  if (pid) {
    live.set(pid, { child, detached, what });
    child.once('exit', () => live.delete(pid));
  } else {
    child.once('spawn', () => {
      if (child.pid) {
        live.set(child.pid, { child, detached, what });
        child.once('exit', () => live.delete(child.pid!));
      }
    });
  }
  return child;
}

let installed = false;

export function installProcessReaper(): void {
  if (installed) return;
  installed = true;
  // The real module object — `import * as cp` is an esbuild interop copy, and
  // patching the copy would change nothing the extension sees.
  const mod = require('node:child_process');
  const realSpawn = mod.spawn;
  const realFork = mod.fork;
  mod.spawn = function (command: string, args?: any, options?: any) {
    const opts = Array.isArray(args) ? options : args;
    const child = realSpawn.apply(this, arguments as any);
    return track(child, !!opts?.detached, `spawn ${command}`);
  };
  mod.fork = function (modulePath: string, args?: any, options?: any) {
    const opts = Array.isArray(args) ? options : args;
    const child = realFork.apply(this, arguments as any);
    return track(child, !!opts?.detached, `fork ${modulePath}`);
  };
}

export function liveChildren(): { pid: number; what: string; detached: boolean }[] {
  return [...live.entries()].map(([pid, t]) => ({ pid, what: t.what, detached: t.detached }));
}

function signal(pid: number, detached: boolean, sig: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      cp.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else if (detached) {
      process.kill(-pid, sig); // the child's whole group (e.g. jest and its workers)
    } else {
      process.kill(pid, sig);
    }
  } catch {
    /* already gone */
  }
}

/** SIGTERM everything, then SIGKILL what is still there after `graceMs`. */
export async function reapChildren(graceMs = 1500): Promise<{ pid: number; what: string; detached: boolean }[]> {
  const victims = [...live.entries()];
  const report = victims.map(([pid, t]) => ({ pid, what: t.what, detached: t.detached }));
  if (!victims.length) return report;
  console.log(`[desktop] stopping ${victims.length} child process(es): ${victims.map(([p, t]) => `${p} ${t.what}`).join(', ')}`);
  for (const [pid, t] of victims) signal(pid, t.detached, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (live.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  for (const [pid, t] of live) signal(pid, t.detached, 'SIGKILL');
  return report;
}

/** Last resort from a synchronous `exit` handler. */
export function killChildrenSync(): void {
  for (const [pid, t] of live) signal(pid, t.detached, 'SIGKILL');
}
