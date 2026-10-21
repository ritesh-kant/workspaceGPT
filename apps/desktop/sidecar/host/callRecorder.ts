/**
 * Recording and transcribing one call, after the user clicked "Take notes"
 * (docs/design/call-notes.md). callDetection.ts decides when; this runs it.
 *
 * On macOS the work is native/wgpt-notes.swift: it taps the call app's audio
 * and the mic, transcribes both on the device, and prints one JSON line per
 * settled segment. This module writes those segments into a call note (the
 * extension's format, services/callNotes.ts), which the Sessions panel lists
 * as it grows. Only text is written; the audio never touches the disk.
 *
 * Deleting the note while it records is the user saying "stop and forget
 * this": the next write finds it gone, stops the helper and writes nothing.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { newCallNoteId, readCallNote, writeCallNote, type CallNote, type CallNoteSpeaker } from 'workspacegpt-extension-callnotes';

export type RecordingEvent =
  | { type: 'recording'; state: 'starting' | 'recording' | 'finishing'; noteId: string; startedAt: number }
  | { type: 'recording'; state: 'idle'; noteId?: string; error?: string }
  | { type: 'recording-notice'; noteId: string; message: string };

type HelperLine =
  | { type: 'state'; state: string }
  | { type: 'segment'; speaker: CallNoteSpeaker; at: number; text: string }
  | { type: 'warning' | 'error'; code: string; message: string }
  | { type: 'done' };

/** How long "stop" may take to print the last segments before the helper is killed. */
const STOP_GRACE_MS = 20_000;

/** Beside the sidecar, in dev (dist/bin) and packaged (runtime/bin) alike. */
export function notesHelperPath(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const bin = process.env.WGPT_NOTES_BIN ?? path.join(__dirname, '..', 'bin', 'wgpt-notes');
  return fs.existsSync(bin) ? bin : undefined;
}

export function callNoteTitle(startedAt: number): string {
  const when = new Date(startedAt).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Call on ${when}`;
}

export class CallRecorder {
  private proc: cp.ChildProcess | undefined;
  private note: CallNote | undefined;
  /** Writes run one at a time, in order. */
  private writing: Promise<void> = Promise.resolve();
  private discarded = false;

  constructor(
    private readonly bin: string,
    private readonly dir: string,
    private readonly send: (event: RecordingEvent) => void
  ) {}

  get active(): boolean {
    return !!this.proc;
  }

  /** `pids`: the processes call detection saw in the call; their audio is the other side. */
  start(pids: number[]): void {
    if (this.proc) return;
    const startedAt = Date.now();
    const note: CallNote = { id: newCallNoteId(startedAt), title: callNoteTitle(startedAt), startedAt, status: 'recording', turns: [] };
    this.note = note;
    this.discarded = false;
    const argv = pids.filter((p) => Number.isInteger(p) && p > 0).flatMap((p) => ['--pid', String(p)]);
    const proc = cp.spawn(this.bin, argv, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.proc = proc;
    this.send({ type: 'recording', state: 'starting', noteId: note.id, startedAt });
    this.save(note, { first: true });
    console.log(`[desktop] call notes: recording ${note.id}`);

    let buffered = '';
    let failure: string | undefined;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        let msg: HelperLine;
        try {
          msg = JSON.parse(line) as HelperLine;
        } catch {
          console.warn(`[desktop] call notes: unreadable line from the helper: ${line.slice(0, 200)}`);
          continue;
        }
        if (msg.type === 'state' && (msg.state === 'recording' || msg.state === 'finishing')) {
          this.send({ type: 'recording', state: msg.state, noteId: note.id, startedAt });
        } else if (msg.type === 'segment' && typeof msg.text === 'string' && msg.text.trim()) {
          note.turns.push({ speaker: msg.speaker === 'you' ? 'you' : 'others', at: Number(msg.at) || 0, text: msg.text });
          this.save(note);
        } else if (msg.type === 'warning') {
          note.notice = note.notice ? `${note.notice} ${msg.message}` : msg.message;
          this.send({ type: 'recording-notice', noteId: note.id, message: msg.message });
          this.save(note);
        } else if (msg.type === 'error') {
          failure = msg.message;
        }
      }
    });
    proc.on('error', (err) => {
      failure = `Could not start recording: ${err.message}`;
    });
    proc.on('close', (code, signal) => {
      if (this.proc === proc) this.proc = undefined;
      if (!failure && code !== 0) failure = `Recording stopped unexpectedly (${code ?? signal}).`;
      // Nothing recorded and it failed: the note would only say so, and the indicator already does.
      if (failure && note.turns.length === 0) {
        this.discarded = true;
        void this.writing.then(() => fs.promises.unlink(path.join(this.dir, `${note.id}.md`)).catch(() => undefined));
      } else {
        note.status = 'done';
        note.endedAt = Date.now();
        if (failure) note.notice = note.notice ? `${note.notice} ${failure}` : failure;
        this.save(note);
      }
      const outcome = failure ? `ended: ${failure}` : this.discarded ? 'deleted, not saved' : 'saved';
      console.log(`[desktop] call notes: ${note.id} ${outcome} (${note.turns.length} turns)`);
      this.send({ type: 'recording', state: 'idle', noteId: note.id, ...(failure ? { error: failure } : {}) });
      if (this.note === note) this.note = undefined;
    });
  }

  /** Ends the recording; the helper prints what is left, then exits. */
  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin?.write('stop\n');
      proc.stdin?.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    }, STOP_GRACE_MS).unref();
  }

  private save(note: CallNote, opts: { first?: boolean } = {}): void {
    this.writing = this.writing.then(async () => {
      if (this.discarded) return;
      if (!opts.first) {
        // A rename in the panel wins; a delete means "stop and forget it".
        const onDisk = await readCallNote(this.dir, note.id);
        if (!onDisk) {
          this.discarded = true;
          console.log(`[desktop] call notes: ${note.id} was deleted while recording; stopping`);
          this.stop();
          return;
        }
        note.title = onDisk.title;
      }
      await writeCallNote(this.dir, note).catch((err) => console.warn(`[desktop] call notes: could not save ${note.id}:`, err));
    });
  }
}
