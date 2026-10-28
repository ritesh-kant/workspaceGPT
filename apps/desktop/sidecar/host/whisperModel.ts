/**
 * The speech model call notes transcribe with (native/wgpt-notes.swift, whisper.cpp):
 * Whisper `small`, multilingual (Hinglish), 5-bit quantized, about 190 MB. Never
 * bundled (the installer's size matters): downloaded the first time call notes
 * are turned on, from a pinned revision, and checked against its SHA-256 before
 * it is used. It lives in the app's data folder, beside the profile.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeError } from '../../../vscode-extensions/src/utils/networkError';

export const WHISPER_MODEL = {
  file: 'ggml-small-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin',
  bytes: 190_085_487,
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
};

export type ModelState =
  | { state: 'ready' }
  | { state: 'missing' }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'failed'; error: string };

export class WhisperModel {
  private current: ModelState;
  private downloading: Promise<void> | undefined;

  constructor(
    private readonly dir: string,
    private readonly onChange: (state: ModelState) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly spec = WHISPER_MODEL
  ) {
    this.current = this.onDisk() ? { state: 'ready' } : { state: 'missing' };
  }

  get path(): string {
    return path.join(this.dir, this.spec.file);
  }

  get state(): ModelState {
    return this.current;
  }

  /** The finished file is only ever written by rename after its checksum passed, so its size is enough. */
  private onDisk(): boolean {
    try {
      return fs.statSync(this.path).size === this.spec.bytes;
    } catch {
      return false;
    }
  }

  private set(state: ModelState): void {
    this.current = state;
    this.onChange(state);
  }

  /** Downloads the model unless it is there or on its way. Resolves when it is ready or has failed. */
  ensure(): Promise<void> {
    if (this.onDisk()) {
      if (this.current.state !== 'ready') this.set({ state: 'ready' });
      return Promise.resolve();
    }
    this.downloading ??= this.download().finally(() => (this.downloading = undefined));
    return this.downloading;
  }

  private async download(): Promise<void> {
    const part = `${this.path}.part`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.set({ state: 'downloading', received: 0, total: this.spec.bytes });
      const res = await this.fetchImpl(this.spec.url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let received = 0;
      let reported = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          received += chunk.length;
          if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
          // About once per percent: the page shows a bar, not a counter.
          if (received - reported >= this.spec.bytes / 100) {
            reported = received;
            this.set({ state: 'downloading', received, total: this.spec.bytes });
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      }
      const sha = hash.digest('hex');
      if (received !== this.spec.bytes || sha !== this.spec.sha256) {
        throw new Error(`the download did not match (${received} bytes, SHA-256 ${sha.slice(0, 12)}…)`);
      }
      fs.renameSync(part, this.path);
      console.log(`[desktop] call notes: speech model ready (${this.spec.file})`);
      this.set({ state: 'ready' });
    } catch (err) {
      fs.rmSync(part, { force: true });
      const error = `Could not download the speech model: ${describeError(err)}`;
      console.warn(`[desktop] call notes: ${error}`);
      this.set({ state: 'failed', error });
    }
  }
}
