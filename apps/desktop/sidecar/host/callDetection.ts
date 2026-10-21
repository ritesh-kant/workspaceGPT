/**
 * Call detection for call notes (beta, desktop only): docs/design/call-notes.md.
 *
 * Not an extension feature. The page turns it on and off with a `calls` frame
 * (host/webviewHost.ts) when the user flips Settings → Call notes, and this
 * module answers with `calls` events: whether detection can run on this machine,
 * and whether the user is in a call right now. It only DETECTS: it never
 * records. The page shows the indicator and asks before anything is recorded.
 *
 * The rule is the same on every OS and names no app, so Teams, Zoom or Meet,
 * in an app, a web app or a browser tab, all count:
 *   a call = some process holding the mic AND audio output for CONFIRM_MS;
 *   it ends after END_MS with none.
 * Muted calls count: call apps keep the mic open while muted (tested on macOS).
 *
 *  - macOS: native/wgpt-calls.swift prints, every few seconds, the processes
 *    holding mic + output (Core Audio per-process state, macOS 14+; no prompt).
 *  - Windows: Windows' own "who is using the microphone" record in the user's
 *    registry (no admin rights). It has no output side, so mic only for now.
 *  - Elsewhere: unavailable.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ViewSurface } from './webviewHost';

export type CallEvent =
  | { type: 'capability'; available: boolean; reason?: string }
  | { type: 'state'; inCall: boolean; since?: number };

export interface CallsRequest {
  op: 'enable' | 'disable';
}

/** Something holding the mic (and, where the OS can tell, audio output). */
export interface Holder {
  key: string;
  name: string;
}

export const CONFIRM_MS = 10_000;
export const END_MS = 15_000;
const POLL_MS = 3_000;

/**
 * The rule over a stream of snapshots, without any I/O, so it can be tested.
 * `update` returns 'start' or 'end' on the snapshot where the state changes.
 */
export class CallTracker {
  private heldSince: number | undefined;
  private lastHeld: number | undefined;
  inCall = false;
  since: number | undefined;

  update(holders: readonly Holder[], now: number): 'start' | 'end' | undefined {
    if (holders.length) {
      this.heldSince ??= now;
      this.lastHeld = now;
      if (!this.inCall && now - this.heldSince >= CONFIRM_MS) {
        this.inCall = true;
        this.since = this.heldSince;
        return 'start';
      }
      return undefined;
    }
    this.heldSince = undefined;
    if (this.inCall && this.lastHeld !== undefined && now - this.lastHeld >= END_MS) {
      this.inCall = false;
      this.since = undefined;
      return 'end';
    }
    return undefined;
  }

  reset(): void {
    this.heldSince = this.lastHeld = this.since = undefined;
    this.inCall = false;
  }
}

const MIC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';

/**
 * `reg query <MIC_KEY> /s` output → apps using the mic now: a key whose
 * LastUsedTimeStart is set and LastUsedTimeStop is 0. Packaged apps are direct
 * subkeys (MSTeams_8wekyb3d8bbwe); desktop apps are under NonPackaged, named by
 * exe path with '#' for '\'.
 */
export function parseWindowsMicUsers(output: string): Holder[] {
  const holders: Holder[] = [];
  let key: string | undefined;
  let start = 0n;
  let stop = 1n;
  const flush = () => {
    if (key && start !== 0n && stop === 0n) {
      const leaf = key.slice(key.lastIndexOf('\\') + 1);
      const name = leaf.replace(/#/g, '\\').split('\\').pop() ?? leaf;
      holders.push({ key: leaf, name });
    }
  };
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^HKEY_/i.test(line)) {
      flush();
      key = line;
      start = 0n;
      stop = 1n;
      continue;
    }
    const m = /^\s+(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+(0x[0-9a-f]+)/i.exec(line);
    if (!m) continue;
    const value = BigInt(m[2]);
    if (m[1].toLowerCase() === 'lastusedtimestart') start = value;
    else stop = value;
  }
  flush();
  return holders;
}

/** Beside the sidecar, in dev (dist/bin) and packaged (runtime/bin) alike. */
function macHelperPath(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const bin = process.env.WGPT_CALLS_BIN ?? path.join(__dirname, '..', 'bin', 'wgpt-calls');
  return fs.existsSync(bin) ? bin : undefined;
}

/** A running snapshot source: calls `onSnapshot` every few seconds until stopped. */
interface Source {
  stop(): void;
}

function startMacSource(bin: string, onSnapshot: (h: Holder[]) => void, onUnsupported: () => void): Source {
  const proc = cp.spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffered = '';
  proc.stdout!.setEncoding('utf8');
  proc.stdout!.on('data', (chunk: string) => {
    buffered += chunk;
    let nl: number;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { unsupported?: boolean; holders?: { pid: number; name: string }[] };
        if (msg.unsupported) onUnsupported();
        else onSnapshot((msg.holders ?? []).map((h) => ({ key: String(h.pid), name: h.name })));
      } catch {
        console.warn(`[desktop] calls: unreadable line from the helper: ${line.slice(0, 200)}`);
      }
    }
  });
  proc.on('error', (err) => console.warn('[desktop] calls: could not start the helper:', err.message));
  return {
    stop: () => {
      try {
        proc.stdin?.end();
      } catch {
        /* already gone */
      }
      setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
    },
  };
}

function startWindowsSource(onSnapshot: (h: Holder[]) => void): Source {
  let stopped = false;
  const poll = () => {
    cp.execFile('reg', ['query', MIC_KEY, '/s'], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (stopped) return;
      // Our own process would hold the mic while dictating, once dictation exists on Windows.
      onSnapshot(err ? [] : parseWindowsMicUsers(stdout).filter((h) => !/^wgpt-/i.test(h.name)));
    });
  };
  poll();
  const timer = setInterval(poll, POLL_MS);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function createCallDetection(surface: ViewSurface, notify: (title: string, body: string) => void): void {
  const macBin = macHelperPath();
  let capability: Extract<CallEvent, { type: 'capability' }> =
    process.platform === 'win32'
      ? { type: 'capability', available: true }
      : macBin
        ? { type: 'capability', available: true }
        : { type: 'capability', available: false, reason: process.platform === 'darwin' ? 'The call-detection helper is missing from this build.' : 'Call notes is available on macOS and Windows.' };

  const send = (event: CallEvent) => surface.sendControl({ t: 'calls', event });
  const tracker = new CallTracker();
  let source: Source | undefined;

  const sendState = () => send({ type: 'state', inCall: tracker.inCall, since: tracker.since });

  const onSnapshot = (holders: Holder[]) => {
    const change = tracker.update(holders, Date.now());
    if (!change) return;
    console.log(`[desktop] calls: ${change === 'start' ? `call detected (${holders.map((h) => h.name).join(', ')})` : 'call ended'}`);
    sendState();
    // The shell only shows this when the window isn't in front; in front, the page's indicator is the prompt.
    if (change === 'start') notify('Call detected', 'Open WorkspaceGPT to choose whether to take notes for this call.');
  };

  const stop = () => {
    source?.stop();
    source = undefined;
    tracker.reset();
    sendState();
  };

  const start = () => {
    if (source || !capability.available) return;
    if (process.platform === 'win32') source = startWindowsSource(onSnapshot);
    else if (macBin)
      source = startMacSource(macBin, onSnapshot, () => {
        capability = { type: 'capability', available: false, reason: 'Call notes needs macOS 14 or later.' };
        send(capability);
        stop();
      });
  };

  surface.attached.event(() => {
    send(capability);
    sendState();
  });
  surface.callsRequested.event((req) => {
    if (req.op === 'enable') start();
    else if (req.op === 'disable') stop();
  });
}
