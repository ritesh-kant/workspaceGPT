/**
 * The speech model Windows dictation listens with (host/dictationWin.ts, sherpa-onnx):
 * a streaming English zipformer, int8, about 73 MB in four files. Never bundled (the
 * installer's size matters): downloaded in the background once the chat page attaches,
 * from a pinned revision, and every file is checked against its SHA-256 before use.
 * It lives in the app's data folder, beside the Whisper model call notes use.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describeError } from '../../../vscode-extensions/src/utils/networkError';

const REVISION = '672fbf1b30579d6585301139bb363f42a0ad4a24';
const CHUNK = 'epoch-99-avg-1-chunk-16-left-128.int8.onnx';

export interface SpeechModelFile {
  file: string;
  bytes: number;
  sha256: string;
}

export const DICTATION_MODEL = {
  dir: 'sherpa-zipformer-en-2023-06-26',
  baseUrl: `https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/resolve/${REVISION}`,
  files: [
    { file: `encoder-${CHUNK}`, bytes: 71_083_163, sha256: '563fde436d16cf7607cf408cd6b30909819d03162652ef389c2450ced3f45ac1' },
    { file: `decoder-${CHUNK}`, bytes: 1_307_236, sha256: '98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02' },
    { file: `joiner-${CHUNK}`, bytes: 259_335, sha256: 'd944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297' },
    { file: 'tokens.txt', bytes: 5_048, sha256: '49e3c2646595fd907228b3c6787069658f67b17377c60aeb8619c4551b2316fb' },
  ] as SpeechModelFile[],
};

export type SpeechModelSpec = typeof DICTATION_MODEL;

export class SpeechModel {
  private downloading: Promise<string | undefined> | undefined;
  /** Why the last download failed, for the page. */
  error: string | undefined;

  constructor(
    private readonly root: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly spec: SpeechModelSpec = DICTATION_MODEL
  ) {}

  get dir(): string {
    return path.join(this.root, this.spec.dir);
  }

  /** Absolute path of one of the model's files. */
  file(name: string): string {
    return path.join(this.dir, name);
  }

  /** A finished file is only ever written by rename after its checksum passed, so its size is enough. */
  get ready(): boolean {
    return this.spec.files.every((f) => {
      try {
        return fs.statSync(this.file(f.file)).size === f.bytes;
      } catch {
        return false;
      }
    });
  }

  /** Downloads what is missing. Resolves to the model's folder, or undefined with `error` set. */
  ensure(): Promise<string | undefined> {
    if (this.ready) return Promise.resolve(this.dir);
    this.downloading ??= this.download().finally(() => (this.downloading = undefined));
    return this.downloading;
  }

  private async download(): Promise<string | undefined> {
    this.error = undefined;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const f of this.spec.files) {
        if (this.has(f)) continue;
        await this.fetchFile(f);
      }
      console.log(`[desktop] dictation: speech model ready (${this.spec.dir})`);
      return this.dir;
    } catch (err) {
      this.error = `Could not download the speech model: ${describeError(err)}`;
      console.warn(`[desktop] dictation: ${this.error}`);
      return undefined;
    }
  }

  private has(f: SpeechModelFile): boolean {
    try {
      return fs.statSync(this.file(f.file)).size === f.bytes;
    } catch {
      return false;
    }
  }

  private async fetchFile(f: SpeechModelFile): Promise<void> {
    const dest = this.file(f.file);
    const part = `${dest}.part`;
    try {
      const res = await this.fetchImpl(`${this.spec.baseUrl}/${f.file}`);
      if (!res.ok || !res.body) throw new Error(`${f.file}: HTTP ${res.status}`);
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(part);
      let received = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          hash.update(chunk);
          received += chunk.length;
          if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      }
      const sha = hash.digest('hex');
      if (received !== f.bytes || sha !== f.sha256) throw new Error(`${f.file}: the download did not match (${received} bytes, SHA-256 ${sha.slice(0, 12)}…)`);
      fs.renameSync(part, dest);
    } catch (err) {
      fs.rmSync(part, { force: true });
      throw err;
    }
  }
}
