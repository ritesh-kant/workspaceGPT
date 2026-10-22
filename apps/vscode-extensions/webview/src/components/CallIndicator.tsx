import React, { useEffect, useRef, useState } from 'react';
import { useCallDetection } from '../hooks/useCallDetection';
import './CallIndicator.css';

type Choice = 'take-notes' | 'not-this-call';

const SAVED_TOAST_MS = 5000;

/** Time since `startedAt` as m:ss. */
export function callClock(startedAt: number, now: number): string {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
}

/**
 * Call notes (beta, desktop only): the "Call detected" prompt and "saved"
 * toast (bottom right), and while a call is recorded, a pill (top right) whose
 * details hold Stop. docs/design/call-notes.md.
 *
 * Nothing records without the "Take notes" click. Recording is always visible
 * here, and stops by itself when the call ends. The choice is per call (keyed
 * by when the call started) and is forgotten when the call ends.
 */
const CallIndicator: React.FC<{
  onOpenNote: (id: string) => void;
  /** The call note on screen: its own view shows the recording and Stop, so this steps aside for it. */
  viewingNoteId?: string;
  /** Your work shows the recording in its own row (CallHomeRow), so the pill is not needed there. */
  hideRecording?: boolean;
}> = ({ onOpenNote, viewingNoteId, hideRecording }) => {
  const { enabled, capability, state, recording, outcome, model, record, stop, retryModel } = useCallDetection();
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [copied, setCopied] = useState(false);
  const [dismissedOutcome, setDismissedOutcome] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  // The pill's details close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  useEffect(() => {
    if (!recording) setOpen(false);
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  // A call being recorded has had its answer (also when it started by itself: Settings → "Take notes automatically"), so Stop does not bring the question back.
  useEffect(() => {
    if (recording && state.inCall && state.since !== undefined) setChoices((prev) => (prev[state.since!] ? prev : { [state.since!]: 'take-notes' }));
  }, [recording, state.inCall, state.since]);

  // "Call notes saved" leaves by itself after a few seconds; it is in the sidebar and on Your work.
  useEffect(() => {
    if (recording || !outcome?.noteId || outcome.error || hovered) return;
    const id = outcome.noteId;
    const timer = setTimeout(() => setDismissedOutcome(id), SAVED_TOAST_MS);
    return () => clearTimeout(timer);
  }, [recording, outcome, hovered]);

  // Saved notes the user is already looking at need no "saved" card afterwards.
  useEffect(() => {
    if (!recording && outcome?.noteId && !outcome.error && outcome.noteId === viewingNoteId) setDismissedOutcome(outcome.noteId);
  }, [recording, outcome, viewingNoteId]);

  const notice = 'Heads up: I’m taking notes of this call with WorkspaceGPT.';
  const copyNotice = () => {
    navigator.clipboard?.writeText(notice).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };
  const copyLink = (label: string) => (
    <button type='button' className='call-indicator-link' onClick={copyNotice}>
      {copied ? 'Copied' : label}
    </button>
  );

  if (recording && recording.noteId === viewingNoteId) return null;
  // Recording: a pill in the top-right corner, with the details and Stop one click away. Your work shows its own row instead.
  if (recording) {
    if (hideRecording) return null;
    const notices = outcome?.noteId === recording.noteId ? outcome.notices : [];
    const title = recording.state === 'finishing' ? 'Finishing the transcript…' : recording.state === 'starting' ? 'Starting to take notes…' : 'Taking notes';
    return (
      <div className='call-pill-anchor' ref={anchor}>
        <button
          type='button'
          className='call-pill'
          aria-expanded={open}
          aria-label={`${title}, ${callClock(recording.startedAt, now)}${notices.length ? ', needs attention' : ''}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className='call-indicator-dot' aria-hidden='true' />
          <span className='call-pill-clock'>{callClock(recording.startedAt, now)}</span>
          {notices.length > 0 && <span className='call-pill-warning' aria-hidden='true'>!</span>}
          <span className='call-pill-chevron' aria-hidden='true'>▾</span>
        </button>
        {open && (
          <div className='call-pop' role='dialog' aria-label='Call notes'>
            <strong className='call-pop-title'>
              <span className='call-indicator-dot' aria-hidden='true' />
              {title}
            </strong>
            <span className='call-indicator-text'>
              {recording.state === 'finishing' ? 'Transcribing the last few seconds on this Mac.' : 'On this Mac. Stops when the call ends.'}
            </span>
            {notices.map((n, i) => (
              <span key={i} className='call-indicator-text call-indicator-warning'>
                {n}
              </span>
            ))}
            <div className='call-indicator-actions'>
              <button
                type='button'
                className='call-indicator-button'
                onClick={() => {
                  setOpen(false);
                  onOpenNote(recording.noteId);
                }}
              >
                Open notes
              </button>
              {recording.state !== 'finishing' && (
                <button type='button' className='call-indicator-button' onClick={stop}>
                  Stop
                </button>
              )}
              {recording.state !== 'finishing' && copyLink('Copy a line for the chat')}
            </div>
          </div>
        )}
      </div>
    );
  }

  // How the last recording ended, until dismissed, unless the next call is waiting for its answer: that question goes first.
  const outcomeKey = outcome?.noteId;
  const callUnanswered = enabled && !!capability?.available && state.inCall && state.since !== undefined && !choices[state.since];
  if (outcome && outcomeKey && dismissedOutcome !== outcomeKey && !(outcomeKey === viewingNoteId && !outcome.error) && !callUnanswered) {
    // Saved: a toast that leaves by itself (not while the pointer is on it). An error stays until dismissed.
    return (
      <div
        className='call-toast'
        role='status'
        aria-live='polite'
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div className='call-toast-row'>
          <span className={`call-indicator-dot call-indicator-dot--still${outcome.error ? ' call-indicator-dot--error' : ''}`} aria-hidden='true' />
          <strong>{outcome.error ? 'Couldn’t take notes' : 'Call notes saved'}</strong>
          {!outcome.error && (
            <button
              type='button'
              className='call-indicator-link'
              onClick={() => {
                setDismissedOutcome(outcomeKey);
                onOpenNote(outcomeKey);
              }}
            >
              Open
            </button>
          )}
          <button type='button' className='call-toast-close' aria-label='Dismiss' onClick={() => setDismissedOutcome(outcomeKey)}>
            ×
          </button>
        </div>
        {outcome.error && <span className='call-indicator-text'>{outcome.error}</span>}
        {!outcome.error && !hovered && <span className='call-toast-timer' key={outcomeKey} />}
      </div>
    );
  }

  if (!enabled || !capability?.available || !state.inCall || state.since === undefined) return null;
  const since = state.since;
  const choice = choices[since];
  if (choice === 'not-this-call') return null;
  const choose = (c: Choice) => {
    setChoices({ [since]: c });
    // The last call's "saved" card was waiting behind this question; it is in the sidebar.
    if (outcomeKey) setDismissedOutcome(outcomeKey);
  };
  // Asked and answered for this call: a recording that ended (Stop) does not ask again.
  if (choice === 'take-notes' && capability.canRecord) return null;

  // Recording works here, but the speech model is not on this Mac yet: say so rather than offer a button that fails.
  const modelReady = !capability.canRecord || model?.state === 'ready';
  const modelLine =
    model?.state === 'downloading'
      ? `The speech model is still downloading (${Math.floor((model.received / Math.max(1, model.total)) * 100)}%). You can take notes once it is ready.`
      : model?.state === 'failed'
        ? model.error
        : 'The speech model is not downloaded yet.';

  // Asked until answered or the call ends: nothing is recorded without "Take notes".
  const close = (
    <button type='button' className='call-toast-close' aria-label={choice === 'take-notes' ? 'Dismiss' : 'Not this call'} onClick={() => choose('not-this-call')}>
      ×
    </button>
  );
  return (
    <div className='call-toast' role='status' aria-live='polite'>
      {!modelReady && choice !== 'take-notes' ? (
        <>
          <div className='call-toast-row'>
            <span className='call-indicator-dot' aria-hidden='true' />
            <strong>Call detected</strong>
            {model?.state !== 'downloading' && (
              <button type='button' className='call-indicator-button call-indicator-button--primary' onClick={retryModel}>
                Download speech model
              </button>
            )}
            {close}
          </div>
          <span className='call-indicator-text'>{modelLine}</span>
        </>
      ) : choice === 'take-notes' ? (
        <>
          <div className='call-toast-row'>
            <span className='call-indicator-dot call-indicator-dot--still call-indicator-dot--error' aria-hidden='true' />
            <strong>No notes are being taken</strong>
            {close}
          </div>
          <span className='call-indicator-text'>{capability.recordReason ?? 'Taking notes is not available in this build.'}</span>
        </>
      ) : (
        <>
          <div className='call-toast-row'>
            <span className='call-indicator-dot' aria-hidden='true' />
            <strong>Call detected</strong>
            <button
              type='button'
              className='call-indicator-button call-indicator-button--primary'
              onClick={() => {
                choose('take-notes');
                if (capability.canRecord) record();
              }}
            >
              Take notes
            </button>
            {close}
          </div>
          <span className='call-indicator-text'>Only if you choose to. Let everyone know: {copyLink('copy a line for the chat')}</span>
        </>
      )}
    </div>
  );
};

export default CallIndicator;
