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
 * Recording starts only on the page's `record` frame, sent when the user
 * clicks "Take notes" (callRecorder.ts), or, when the user turned on "Take
 * notes automatically" in Settings, as soon as a call is detected. It stops on `stop`, when the call
 * ends, or when call notes are turned off.
 *
 *  - macOS: native/wgpt-calls.swift prints, every few seconds, the processes
 *    holding mic + output (Core Audio per-process state, macOS 14+; no prompt).
 *  - Windows: native/win-calls enumerates active WASAPI capture and render
 *    sessions, grouping browser helper processes under the same app.
 *  - Elsewhere: unavailable.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ViewSurface } from './webviewHost';
import { CallRecorder, closeInterruptedNotes, notesHelperPath, type RecordingEvent } from './callRecorder';
import { WhisperModel, type ModelState } from './whisperModel';

export type CallEvent =
  | { type: 'capability'; available: boolean; reason?: string; canRecord?: boolean; recordReason?: string }
  | { type: 'state'; inCall: boolean; since?: number }
  /** The speech model "Take notes" needs: downloaded when call notes are turned on (whisperModel.ts). */
  | ({ type: 'model' } & ModelState)
  | RecordingEvent;

export interface CallsRequest {
  op: 'enable' | 'disable' | 'record' | 'stop';
  /** With 'enable': Settings → "Take notes automatically", so a detected call records without asking. */
  auto?: boolean;
  /** With 'stop': the note to end; one marked "recording" that nothing records any more is closed. */
  noteId?: string;
}

/** Something holding the mic (and, where the OS can tell, audio output). */
export interface Holder {
  key: string;
  name: string;
}

export const CONFIRM_MS = 10_000;
/** Short enough that a note closes soon after hanging up; long enough to ride out a device switch (AirPods connecting) mid-call. */
export const END_MS = 8_000;

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

/** Beside the sidecar, in dev (dist/bin) and packaged (runtime/bin) alike. */
function callsHelperPath(): string | undefined {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return undefined;
  const bin = process.env.WGPT_CALLS_BIN ?? path.join(__dirname, '..', 'bin', process.platform === 'win32' ? 'wgpt-calls.exe' : 'wgpt-calls');
  return fs.existsSync(bin) ? bin : undefined;
}

/** A running snapshot source: calls `onSnapshot` every few seconds until stopped. */
interface Source {
  stop(): void;
}

export function startNativeSource(bin: string, onSnapshot: (h: Holder[]) => void, onFailure: (reason: string) => void, args = process.platform === 'win32' ? ['--detect'] : []): Source {
  const proc = cp.spawn(bin, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  let stopped = false;
  let failed = false;
  const fail = (reason: string) => {
    if (stopped || failed) return;
    failed = true;
    console.warn(`[desktop] calls: ${reason}`);
    onFailure(reason);
  };
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
        const msg = JSON.parse(line) as { unsupported?: boolean; type?: string; message?: string; holders?: { pid: number; name: string }[] };
        if (stopped || failed) continue;
        if (msg.unsupported) fail('Call notes needs macOS 14 or later.');
        else if (msg.type === 'error') fail(msg.message ?? 'Could not read active audio sessions.');
        else onSnapshot((msg.holders ?? []).map((h) => ({ key: String(h.pid), name: h.name })));
      } catch {
        console.warn(`[desktop] calls: unreadable line from the helper: ${line.slice(0, 200)}`);
      }
    }
  });
  proc.on('error', (err) => fail(`Could not start call detection: ${err.message}`));
  proc.on('close', (code, signal) => fail(`Call detection stopped unexpectedly (${code ?? signal}). Turn Detect calls off and on to retry.`));
  return {
    stop: () => {
      stopped = true;
      try {
        proc.stdin?.end();
      } catch {
        /* already gone */
      }
      setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
    },
  };
}

export function createCallDetection(
  surface: ViewSurface,
  notesDir: string,
  modelDir: string,
  notify: (title: string, body: string) => void
): void {
  const callsBin = callsHelperPath();
  const notesBin = notesHelperPath();
  // macOS 14 = Darwin 23: the first that can tap a call app's audio (and the recorder needs 13.3).
  const macOld = process.platform === 'darwin' && Number(os.release().split('.')[0]) < 23;
  // Process loopback capture is available from Windows build 20348. Detection still works on older builds.
  const windowsOld = process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) < 20348;
  const recordability =
    notesBin && !macOld && !windowsOld
      ? { canRecord: true }
      : {
          canRecord: false,
          recordReason:
            windowsOld
              ? 'Taking notes needs Windows build 20348 or later (Windows 11 or Windows Server 2022).'
              : macOld
                ? 'Taking notes needs macOS 14 or later.'
                : 'The call-notes helper is missing from this build.',
        };
  const initialCapability: Extract<CallEvent, { type: 'capability' }> = callsBin
    ? { type: 'capability', available: true, ...recordability }
    : { type: 'capability', available: false, reason: ['darwin', 'win32'].includes(process.platform) ? 'The call-detection helper is missing from this build.' : 'Call notes is available on macOS and Windows.' };
  let capability = initialCapability;

  const send = (event: CallEvent) => surface.sendControl({ t: 'calls', event });
  const tracker = new CallTracker();
  let source: Source | undefined;
  /** Who held mic + output in the last snapshot: on macOS their pids, whose audio is the other side of the call. */
  let lastHolders: Holder[] = [];
  /** The recording's latest state, replayed to a page that (re)attaches mid-call. */
  let recordingState: RecordingEvent | undefined;
  /** The user turned on "Take notes automatically". */
  let auto = false;
  /** The call (its `since`) a recording was last started for, so auto-record starts once per call. */
  let recordedSince: number | undefined;
  const model = new WhisperModel(modelDir, (state) => {
    send({ type: 'model', ...state });
    if (state.state === 'ready') autoRecord();
  });
  const recorder =
    notesBin && recordability.canRecord
      ? new CallRecorder(
          notesBin,
          notesDir,
          (event) => {
            if (event.type === 'recording') recordingState = event.state === 'idle' ? undefined : event;
            send(event);
            // A call that started while the last one's transcript was still finishing.
            if (event.type === 'recording' && event.state === 'idle') autoRecord();
          },
          model.path
        )
      : undefined;

  const sendState = () => send({ type: 'state', inCall: tracker.inCall, since: tracker.since });
  void closeInterruptedNotes(notesDir, { live: () => recorder?.noteId });

  const record = () => {
    recordedSince = tracker.since;
    recorder!.start(lastHolders.map((h) => Number(h.key)));
  };

  /** Records the call in progress without asking, when the user chose that; still shown on the page, with Stop. */
  const autoRecord = (): boolean => {
    if (!auto || !recorder || recorder.active || !tracker.inCall || recordedSince === tracker.since || model.state.state !== 'ready') return false;
    record();
    notify('Taking notes of this call', 'WorkspaceGPT is transcribing this call on this device. Let everyone on the call know. Open WorkspaceGPT to stop.');
    return true;
  };

  const onSnapshot = (holders: Holder[]) => {
    if (holders.length) lastHolders = holders;
    const change = tracker.update(holders, Date.now());
    if (!change) return;
    // The call is over: so is its recording (the helper transcribes what is left first).
    if (change === 'end') recorder?.stop();
    console.log(`[desktop] calls: ${change === 'start' ? `call detected (${holders.map((h) => h.name).join(', ')})` : `call ended (no audio for ${END_MS / 1000} s)`}`);
    // Before the state, so the page shows the recording rather than flashing the question first.
    const autoStarted = change === 'start' && autoRecord();
    sendState();
    // The shell only shows this when the window isn't in front; in front, the page's indicator is the prompt.
    if (change === 'start' && !autoStarted) notify('Call detected', 'Open WorkspaceGPT to choose whether to take notes for this call.');
  };

  const stop = () => {
    recorder?.stop();
    source?.stop();
    source = undefined;
    tracker.reset();
    sendState();
  };

  const start = () => {
    // Turning call notes on is when the model comes down, so "Take notes" works on the first call.
    if (recorder) void model.ensure();
    if (source || !capability.available) return;
    if (callsBin) source = startNativeSource(callsBin, onSnapshot, (reason) => {
      capability = { type: 'capability', available: false, reason };
      send(capability);
      stop();
    });
  };

  surface.attached.event(() => {
    send(capability);
    sendState();
    if (recorder) send({ type: 'model', ...model.state });
    // Always: a page that outlived the previous host must hear that nothing records now.
    send(recordingState ?? { type: 'recording', state: 'idle' });
  });
  surface.callsRequested.event((req) => {
    if (req.op === 'enable') {
      auto = !!req.auto;
      start();
      autoRecord();
    } else if (req.op === 'disable') {
      stop();
      capability = initialCapability;
      send(capability);
    }
    // Only for a call in progress: the page asks after detection, and only on the user's click.
    else if (req.op === 'record' && tracker.inCall && recorder && !recorder.active) {
      if (model.state.state !== 'ready') {
        // The page only offers "Take notes" once the model is ready; this is the race where it was not.
        send({ type: 'recording', state: 'idle', error: 'The speech model is not downloaded yet. Try again once Settings → Call notes says it is ready.' });
        void model.ensure();
      } else record();
    } else if (req.op === 'stop') {
      if (req.noteId && req.noteId !== recorder?.noteId) void closeInterruptedNotes(notesDir, { live: () => recorder?.noteId, only: req.noteId });
      else recorder?.stop();
    }
  });
}
