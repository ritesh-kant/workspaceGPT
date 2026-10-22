import { useEffect, useState } from 'react';
import { isDesktopHost } from '../vscode';
import { useSettingsStore } from '../store/settingsStore';

/**
 * Call notes (beta, desktop only): whether the desktop host can detect calls
 * here, whether the user is in one now, and whether a call is being recorded
 * (apps/desktop/sidecar/host/callDetection.ts and callRecorder.ts). Turns
 * detection on or off as Settings → Call notes changes. In VS Code there is no
 * bridge, so this reports unavailable and does nothing.
 */
type CallsOp = 'enable' | 'disable' | 'record' | 'stop';
interface CallsBridge {
  latest(): { capability?: CallCapability; state?: CallState; recording?: CallRecording; model?: SpeechModel };
  request(op: CallsOp, auto?: boolean): void;
}
export interface CallCapability {
  available: boolean;
  reason?: string;
  /** Whether "Take notes" can record here (macOS today); `recordReason` says why not. */
  canRecord?: boolean;
  recordReason?: string;
}
export interface CallState {
  inCall: boolean;
  /** When the call's audio started (ms since epoch); identifies this call. */
  since?: number;
}
export interface CallRecording {
  state: 'starting' | 'recording' | 'finishing';
  /** The call note being written (services/callNotes.ts). */
  noteId: string;
  startedAt: number;
}
/** The speech model "Take notes" transcribes with, downloaded when call notes are turned on. */
export type SpeechModel =
  | { state: 'ready' | 'missing' }
  | { state: 'downloading'; received: number; total: number }
  | { state: 'failed'; error: string };

/** How the last recording ended, for the indicator to say so: an error, or what one side lacked. */
export interface RecordingOutcome {
  noteId?: string;
  error?: string;
  notices: string[];
  /** When the recording started and ended, for the home row's "Last call notes". */
  startedAt?: number;
  endedAt?: number;
}

// Shared by every use of the hook, so one mounted later (the home row) still knows how the last recording went.
let lastOutcome: RecordingOutcome | undefined;
const startedAt: Record<string, number> = {};

const bridge = (): CallsBridge | undefined => (window as { __wgptBridge?: { calls?: CallsBridge } }).__wgptBridge?.calls;

/** `control: false` only listens: it never turns detection on or off (the note view uses it for Stop). */
export function useCallDetection({ control = true }: { control?: boolean } = {}): {
  enabled: boolean;
  autoRecord: boolean;
  capability: CallCapability | undefined;
  state: CallState;
  recording: CallRecording | undefined;
  outcome: RecordingOutcome | undefined;
  model: SpeechModel | undefined;
  record(): void;
  stop(): void;
  /** Ask again for the model after a failed download (turning detection on fetches it). */
  retryModel(): void;
} {
  const enabled = useSettingsStore((s) => !!s.config.callNotes?.enabled);
  const autoRecord = useSettingsStore((s) => !!s.config.callNotes?.autoRecord);
  const [capability, setCapability] = useState<CallCapability | undefined>(() => bridge()?.latest().capability);
  const [state, setState] = useState<CallState>(() => bridge()?.latest().state ?? { inCall: false });
  const [recording, setRecording] = useState<CallRecording | undefined>(() => bridge()?.latest().recording);
  const [outcome, setOutcomeState] = useState<RecordingOutcome | undefined>(() => lastOutcome);
  const setOutcome = (next: (prev: RecordingOutcome | undefined) => RecordingOutcome) =>
    setOutcomeState((prev) => (lastOutcome = next(prev)));
  const [model, setModel] = useState<SpeechModel | undefined>(() => bridge()?.latest().model);

  useEffect(() => {
    if (!isDesktopHost()) return;
    const onEvent = (e: Event) => {
      const event = (e as CustomEvent).detail as
        | ({ type?: string; state?: string; noteId?: string; startedAt?: number; error?: string; message?: string } & Partial<CallCapability> &
            Partial<Omit<CallState, 'state'>>)
        | undefined;
      if (event?.type === 'capability') {
        setCapability({ available: !!event.available, reason: event.reason, canRecord: !!event.canRecord, recordReason: event.recordReason });
      } else if (event?.type === 'state') {
        setState({ inCall: !!event.inCall, since: event.since });
      } else if (event?.type === 'recording') {
        if (event.state === 'idle') {
          setRecording(undefined);
          setOutcome((prev) => ({
            noteId: event.noteId,
            error: event.error,
            notices: prev && prev.noteId === event.noteId ? prev.notices : [],
            startedAt: event.noteId ? startedAt[event.noteId] : undefined,
            endedAt: Date.now(),
          }));
        } else if (event.noteId && (event.state === 'starting' || event.state === 'recording' || event.state === 'finishing')) {
          const noteId = event.noteId;
          startedAt[noteId] ??= event.startedAt ?? Date.now();
          setRecording({ state: event.state, noteId, startedAt: event.startedAt ?? Date.now() });
          if (event.state === 'starting') setOutcome(() => ({ noteId, notices: [] }));
        }
      } else if (event?.type === 'model') {
        const m = event as unknown as SpeechModel;
        setModel(m.state === 'downloading' ? { state: 'downloading', received: m.received, total: m.total } : m.state === 'failed' ? { state: 'failed', error: m.error } : { state: m.state });
      } else if (event?.type === 'recording-notice' && event.message) {
        const message = event.message;
        setOutcome((prev) => ({ ...(prev && prev.noteId === event.noteId ? prev : {}), noteId: event.noteId, error: prev?.error, notices: [...(prev && prev.noteId === event.noteId ? prev.notices : []), message] }));
      }
    };
    window.addEventListener('wgpt-calls', onEvent);
    return () => window.removeEventListener('wgpt-calls', onEvent);
  }, []);

  // The host forgets on restart; re-sent whenever the setting or the host's capability changes.
  useEffect(() => {
    if (!isDesktopHost() || !control) return;
    bridge()?.request(enabled ? 'enable' : 'disable', autoRecord);
  }, [enabled, autoRecord, capability?.available, control]);

  return {
    enabled,
    autoRecord,
    capability,
    state,
    recording,
    outcome,
    model,
    record: () => bridge()?.request('record'),
    stop: () => bridge()?.request('stop'),
    retryModel: () => bridge()?.request('enable'),
  };
}
