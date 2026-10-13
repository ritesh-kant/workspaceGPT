/**
 * Dictation for the composer's mic button.
 *
 * Not an extension feature: the chat page asks for it with a `dictation`
 * frame (host/webviewHost.ts), and this module answers with the same frame
 * type. On macOS the recognition itself is the system's, run by a small helper
 * (native/wgpt-dictate.swift) that prints one JSON event per line; this module
 * starts it, relays its events to the page, and ends it on request, when the
 * page goes away, or when the helper does. Audio stays on the machine — the
 * helper refuses to fall back to a server.
 *
 * `capability` tells the page whether to draw the mic at all: only where the
 * helper exists (macOS builds), so other platforms show nothing rather than a
 * button that cannot work.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ViewSurface } from './webviewHost';

export type DictationEvent =
  | { type: 'capability'; available: boolean }
  | { type: 'state'; state: 'starting' | 'listening' | 'finishing' | 'idle' }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'error'; code: string; message: string };

export interface DictationRequest {
  op: 'start' | 'stop' | 'cancel';
  locale?: string;
}

/** A BCP-47 tag such as en-US — the only thing from the page that reaches the helper's argv. */
const LOCALE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8}){0,4}$/;

/** Beside the sidecar, in dev (dist/bin) and packaged (runtime/bin) alike. */
function helperPath(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const bin = process.env.WGPT_DICTATE_BIN ?? path.join(__dirname, '..', 'bin', 'wgpt-dictate');
  return fs.existsSync(bin) ? bin : undefined;
}

export function createDictation(surface: ViewSurface): void {
  const bin = helperPath();
  const send = (event: DictationEvent) => surface.sendControl({ t: 'dictation', event });
  let child: cp.ChildProcess | undefined;
  /** Helpers asked to cancel: their exit without a result is the answer, not a crash. */
  const cancelled = new WeakSet<cp.ChildProcess>();

  surface.attached.event(() => send({ type: 'capability', available: !!bin }));

  /** Ends the helper: it delivers what it heard on "stop", nothing on "cancel". */
  const tell = (word: 'stop' | 'cancel') => {
    const proc = child;
    if (!proc) return;
    try {
      proc.stdin?.write(`${word}\n`);
    } catch {
      /* already gone */
    }
    // The helper exits by itself; this is for one that has hung.
    if (word === 'cancel') {
      cancelled.add(proc);
      setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
    }
  };

  const start = (locale: string) => {
    if (!bin || child) return;
    const proc = cp.spawn(bin, ['--locale', locale], { stdio: ['pipe', 'pipe', 'inherit'] });
    child = proc;
    let buffered = '';
    let ended = false;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as DictationEvent;
          if (event.type === 'final' || event.type === 'error') ended = true;
          send(event);
        } catch {
          console.warn(`[desktop] dictation: unreadable line from the helper: ${line.slice(0, 200)}`);
        }
      }
    });
    proc.on('error', (err) => {
      console.warn('[desktop] dictation: could not start the helper:', err.message);
      if (child === proc) child = undefined;
      send({ type: 'error', code: 'helper-failed', message: `Could not start dictation: ${err.message}` });
      send({ type: 'state', state: 'idle' });
    });
    proc.on('exit', (code, signal) => {
      if (child === proc) child = undefined;
      // A helper that died without saying so would leave the mic button stuck on.
      if (!ended && !cancelled.has(proc)) {
        console.warn(`[desktop] dictation: helper exited (${code ?? signal}) without a result`);
        send({ type: 'error', code: 'helper-crashed', message: 'Dictation stopped unexpectedly.' });
      }
      if (!ended) send({ type: 'state', state: 'idle' });
    });
  };

  surface.dictationRequested.event((req) => {
    if (req.op === 'start') {
      const locale = typeof req.locale === 'string' && LOCALE.test(req.locale) ? req.locale : 'en-US';
      start(locale);
    } else if (req.op === 'stop') tell('stop');
    else if (req.op === 'cancel') tell('cancel');
  });

  // A page that went away (reload, window closed) can no longer show the mic's state or take the text.
  surface.view.onDidChangeVisibility(() => {
    if (!surface.connected) tell('cancel');
  });
}
