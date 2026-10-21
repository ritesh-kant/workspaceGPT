import React, { useState } from 'react';
import { useCallDetection } from '../hooks/useCallDetection';
import './CallIndicator.css';

type Choice = 'take-notes' | 'not-this-call';

/**
 * Call notes (beta, desktop only): the "Call detected" indicator and the
 * ask-before-recording prompt. docs/design/call-notes.md.
 *
 * Nothing records without the click. This build only detects calls; recording
 * and transcription come next, so "Take notes" says so instead of pretending.
 * The choice is per call (keyed by when the call started) and is forgotten when
 * the call ends.
 */
const CallIndicator: React.FC = () => {
  const { enabled, capability, state } = useCallDetection();
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  const [copied, setCopied] = useState(false);

  if (!enabled || !capability?.available || !state.inCall || state.since === undefined) return null;
  const since = state.since;
  const choice = choices[since];
  if (choice === 'not-this-call') return null;
  const choose = (c: Choice) => setChoices({ [since]: c });

  const notice = 'Heads up: I’m taking notes of this call with WorkspaceGPT.';
  const copyNotice = () => {
    navigator.clipboard?.writeText(notice).then(
      () => setCopied(true),
      () => setCopied(false)
    );
  };

  return (
    <div className='call-indicator' role='status' aria-live='polite'>
      <span className='call-indicator-dot' aria-hidden='true' />
      {choice === 'take-notes' ? (
        <div className='call-indicator-body'>
          <strong>Call detected · notes requested</strong>
          <span className='call-indicator-text'>Recording and transcription arrive in the next beta build. This build only detects calls; nothing is being recorded.</span>
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
            Nothing is recorded unless you choose to. If you do, let everyone on the call know.{' '}
            <button type='button' className='call-indicator-link' onClick={copyNotice}>
              {copied ? 'Copied' : 'Copy a line for the chat'}
            </button>
          </span>
          <div className='call-indicator-actions'>
            <button type='button' className='call-indicator-button call-indicator-button--primary' onClick={() => choose('take-notes')}>
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
