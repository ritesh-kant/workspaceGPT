import React, { useEffect, useState } from 'react';
import { useCallDetection } from '../hooks/useCallDetection';
import './CallIndicator.css';

type Choice = 'take-notes' | 'not-this-call';

/**
 * Call notes (beta, desktop only): the "Call detected" prompt, and while a
 * call is recorded, the recording indicator with Stop. docs/design/call-notes.md.
 *
 * Nothing records without the "Take notes" click. Recording is always visible
 * here, and stops by itself when the call ends. The choice is per call (keyed
 * by when the call started) and is forgotten when the call ends.
 */
const CallIndicator: React.FC<{
  onOpenNote: (id: string) => void;
  /** The call note on screen: its own view shows the recording and Stop, so this steps aside for it. */
  viewingNoteId?: string;
}> = ({ onOpenNote, viewingNoteId }) => {
  const { enabled, capability, state, recording, outcome, record, stop } = useCallDetection();
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [copied, setCopied] = useState(false);
  const [dismissedOutcome, setDismissedOutcome] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

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
  const copyLink = (
    <button type='button' className='call-indicator-link' onClick={copyNotice}>
      {copied ? 'Copied' : 'Copy a line for the chat'}
    </button>
  );

  if (recording && recording.noteId === viewingNoteId) return null;
  // Recording: shown whatever else is going on, until it has finished.
  if (recording) {
    const elapsed = Math.max(0, Math.floor((now - recording.startedAt) / 1000));
    const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
    const notices = outcome?.noteId === recording.noteId ? outcome.notices : [];
    return (
      <div className='call-indicator' role='status' aria-live='polite'>
        <span className='call-indicator-dot' aria-hidden='true' />
        <div className='call-indicator-body'>
          <strong>
            {recording.state === 'finishing' ? 'Finishing the transcript…' : recording.state === 'starting' ? 'Starting to take notes…' : `Taking notes · ${clock}`}
          </strong>
          <span className='call-indicator-text'>
            {recording.state === 'finishing'
              ? 'Transcribing the last few seconds on this Mac.'
              : 'Transcribing on this Mac. Stops by itself when the call ends.'}{' '}
            {recording.state !== 'finishing' && copyLink}
          </span>
          {notices.map((n, i) => (
            <span key={i} className='call-indicator-text call-indicator-warning'>
              {n}
            </span>
          ))}
          <div className='call-indicator-actions'>
            <button type='button' className='call-indicator-button' onClick={() => onOpenNote(recording.noteId)}>
              Open notes
            </button>
            {recording.state !== 'finishing' && (
              <button type='button' className='call-indicator-button call-indicator-button--primary' onClick={stop}>
                Stop
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // How the last recording ended, until dismissed.
  const outcomeKey = outcome?.noteId;
  if (outcome && outcomeKey && dismissedOutcome !== outcomeKey && !(outcomeKey === viewingNoteId && !outcome.error)) {
    return (
      <div className='call-indicator' role='status' aria-live='polite'>
        <span className='call-indicator-dot call-indicator-dot--still' aria-hidden='true' />
        <div className='call-indicator-body'>
          <strong>{outcome.error ? 'Couldn’t take notes' : 'Call notes saved'}</strong>
          <span className='call-indicator-text'>
            {outcome.error ?? 'Find them under Call notes in the sidebar, or ask about the call in a chat.'}
          </span>
          <div className='call-indicator-actions'>
            {!outcome.error && (
              <button
                type='button'
                className='call-indicator-button call-indicator-button--primary'
                onClick={() => {
                  setDismissedOutcome(outcomeKey);
                  onOpenNote(outcomeKey);
                }}
              >
                Open notes
              </button>
            )}
            <button type='button' className='call-indicator-button' onClick={() => setDismissedOutcome(outcomeKey)}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!enabled || !capability?.available || !state.inCall || state.since === undefined) return null;
  const since = state.since;
  const choice = choices[since];
  if (choice === 'not-this-call') return null;
  const choose = (c: Choice) => setChoices({ [since]: c });
  // Asked and answered for this call: a recording that ended (Stop) does not ask again.
  if (choice === 'take-notes' && capability.canRecord) return null;

  return (
    <div className='call-indicator' role='status' aria-live='polite'>
      <span className='call-indicator-dot' aria-hidden='true' />
      {choice === 'take-notes' ? (
        <div className='call-indicator-body'>
          <strong>Call detected · notes requested</strong>
          <span className='call-indicator-text'>
            {capability.recordReason ?? 'Taking notes is not available in this build.'} Nothing is being recorded.
          </span>
          <div className='call-indicator-actions'>
            <button type='button' className='call-indicator-button' onClick={() => choose('not-this-call')}>
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <div className='call-indicator-body'>
          <strong>Call detected. Take notes for this call?</strong>
          <span className='call-indicator-text'>
            Nothing is recorded unless you choose to. If you do, let everyone on the call know. {copyLink}
          </span>
          <div className='call-indicator-actions'>
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
            <button type='button' className='call-indicator-button' onClick={() => choose('not-this-call')}>
              Not this call
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CallIndicator;
