/**
 * Dictation on Windows (host/dictation.ts hands the mic button's requests here).
 *
 * macOS has the system's speech recognizer behind a helper; Windows has none that
 * runs fully on the machine, so the sidecar listens itself: native/win-mic
 * (wgpt-mic.exe) streams the default microphone as 16 kHz mono PCM, and sherpa-onnx's
 * streaming recognizer (host/speechModel.ts) turns it into words as they are spoken.
 * Same events as the macOS helper, so the page cannot tell them apart. Audio stays on
 * the machine: there is no server to fall back to.
 *
 * The recognizer is loaded once and kept (loading the model takes a second or two);
 * each dictation gets its own stream.
 */
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DictationEvent } from './dictation';
import type { SpeechModel } from './speechModel';

/** The few sherpa-onnx-node calls used, so a test can stand in for the addon. */
export interface OnlineStreamLike {
  acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void;
  inputFinished(): void;
}
export interface RecognizerLike {
  createStream(): OnlineStreamLike;
  isReady(s: OnlineStreamLike): boolean;
  decode(s: OnlineStreamLike): void;
  isEndpoint(s: OnlineStreamLike): boolean;
  reset(s: OnlineStreamLike): void;
  getResult(s: OnlineStreamLike): { text: string };
}

/** Beside the sidecar, in dev (dist/bin) and packaged (runtime/bin) alike. */
export function micHelperPath(): string | undefined {
  if (process.platform !== 'win32' && !process.env.WGPT_MIC_BIN) return undefined;
  const bin = process.env.WGPT_MIC_BIN ?? path.join(__dirname, '..', 'bin', 'wgpt-mic.exe');
  return fs.existsSync(bin) ? bin : undefined;
}

let recognizer: Promise<RecognizerLike> | undefined;

function loadRecognizer(model: SpeechModel): Promise<RecognizerLike> {
  recognizer ??= (async () => {
    // A native addon staged beside the sidecar (esbuild external); absent in a build without it.
    const sherpa = require('sherpa-onnx-node') as { OnlineRecognizer: new (config: unknown) => RecognizerLike };
    const [encoder, decoder, joiner] = ['encoder-', 'decoder-', 'joiner-'].map((p) => model.file(fs.readdirSync(model.dir).find((f) => f.startsWith(p) && f.endsWith('.onnx'))!));
    return new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { transducer: { encoder, decoder, joiner }, tokens: model.file('tokens.txt'), numThreads: 2, provider: 'cpu' },
      decodingMethod: 'greedy_search',
      // A pause of ~0.8 s closes a phrase, so a long dictation does not grow one ever-longer hypothesis.
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 0.8,
      rule3MinUtteranceLength: 20,
    });
  })();
  recognizer.catch(() => (recognizer = undefined));
  return recognizer;
}

/** The model writes capitals with no punctuation: sentence case it, and keep "I" a capital. */
export function sentenceCase(text: string): string {
  const lower = text.trim().toLowerCase().replace(/\bi\b/g, 'I');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export interface WindowsDictation {
  /** Ends listening and delivers what was heard. */
  stop(): void;
  /** Ends listening and delivers nothing. */
  cancel(): void;
}

export function startWindowsDictation(opts: { mic: string; model: SpeechModel; emit: (event: DictationEvent) => void }): WindowsDictation {
  const { emit } = opts;
  let wanted = 'listen' as 'listen' | 'stop' | 'cancel';
  let mic: cp.ChildProcess | undefined;
  let finished = false;

  const idle = () => {
    if (finished) return;
    finished = true;
    emit({ type: 'state', state: 'idle' });
  };
  const fail = (code: string, message: string) => {
    if (finished) return;
    emit({ type: 'error', code, message });
    idle();
  };

  emit({ type: 'state', state: 'starting' });

  void (async () => {
    // The model downloads in the background from the moment the page attaches; a click before it lands waits here.
    if (!(await opts.model.ensure())) return fail('model-download', opts.model.error ?? 'The speech model is not available.');
    let rec: RecognizerLike;
    try {
      rec = await loadRecognizer(opts.model);
    } catch (err) {
      console.warn('[desktop] dictation: could not load the speech recognizer:', err);
      return fail('engine-missing', `Speech recognition could not start on this machine: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
    if (wanted === 'cancel') return idle();
    if (wanted === 'stop') {
      emit({ type: 'final', text: '' });
      return idle();
    }

    const stream = rec.createStream();
    let committed = '';
    let lastPartial = '';
    let carry: Buffer = Buffer.alloc(0);
    let heard = false;
    let stderr = '';

    const decodeReady = () => {
      while (rec.isReady(stream)) rec.decode(stream);
    };
    const current = () => {
      const text = rec.getResult(stream).text.trim();
      return [committed, text].filter(Boolean).join(' ');
    };
    const feed = (chunk: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const n = buf.length >> 1;
      carry = buf.subarray(n * 2);
      if (!n) return;
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
      stream.acceptWaveform({ sampleRate: 16000, samples });
      decodeReady();
      if (rec.isEndpoint(stream)) {
        committed = current();
        rec.reset(stream);
      }
      const text = sentenceCase(current());
      if (text && text !== lastPartial) {
        lastPartial = text;
        emit({ type: 'partial', text });
      }
    };

    const proc = cp.spawn(opts.mic, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    mic = proc;
    proc.stdout!.on('data', (chunk: Buffer) => {
      if (finished || wanted === 'cancel') return;
      if (!heard) {
        heard = true;
        emit({ type: 'state', state: 'listening' });
      }
      feed(chunk);
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (s: string) => (stderr += s));
    proc.on('error', (err) => fail('helper-failed', `Could not start dictation: ${err.message}`));
    proc.on('close', () => {
      if (finished) return;
      if (wanted === 'cancel') return idle();
      // The helper's own words ("ERR <code> <message>") say what went wrong with the mic.
      const reported = /^ERR (\S+) (.*)$/m.exec(stderr);
      if (reported) return fail(reported[1] === 'no-device' ? 'no-microphone' : reported[1], reported[2]);
      if (wanted !== 'stop') return fail('helper-crashed', 'Dictation stopped unexpectedly.');
      // Stopped: pad with silence so the last word is flushed, then settle.
      stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(6400) });
      stream.inputFinished();
      decodeReady();
      emit({ type: 'final', text: sentenceCase(current()) });
      idle();
    });
    if (wanted !== 'listen') end();
  })();

  /** Asks the mic helper to finish; its exit completes the dictation. */
  function end() {
    try {
      mic?.stdin?.write('stop\n');
    } catch {
      /* already gone */
    }
    // The helper exits by itself; this is for one that has hung.
    const proc = mic;
    setTimeout(() => proc?.kill(), 3000).unref();
  }

  return {
    stop() {
      if (wanted !== 'listen') return;
      wanted = 'stop';
      emit({ type: 'state', state: 'finishing' });
      if (mic) end();
    },
    cancel() {
      if (wanted === 'cancel') return;
      wanted = 'cancel';
      if (mic) end();
      else idle();
    },
  };
}
