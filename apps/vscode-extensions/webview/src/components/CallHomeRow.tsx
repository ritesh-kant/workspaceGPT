import React, { useEffect, useState } from 'react';
import { useCallDetection } from '../hooks/useCallDetection';
import { useUiStore } from '../store/uiStore';
import { callClock } from './CallIndicator';
import './CallIndicator.css';


/**
 * Call notes on Your work (desktop): the call notes are being taken of, with
 * Stop, or once it ends, a way back to its notes. Nothing when neither.
 */
const CallHomeRow: React.FC = () => {
  const { recording, outcome, stop } = useCallDetection({ control: false });
  const [now, setNow] = useState(() => Date.now());
  const open = (id: string) => useUiStore.getState().openCallNote(id);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  if (recording) {
    const notices = outcome?.noteId === recording.noteId ? outcome.notices : [];
    return (
      <div className='call-home-row' role='status'>
        <span className='call-indicator-dot' aria-hidden='true' />
        <strong>{recording.state === 'finishing' ? 'Finishing the transcript…' : 'Taking notes'}</strong>
        <span className='call-home-row-meta' title={notices.join(' ')}>
          · {callClock(recording.startedAt, now)}
          {notices.length > 0 && <span className='call-indicator-warning'> · {notices.length === 1 ? 'one side isn’t transcribed' : 'needs attention'}</span>}
        </span>
        <button type='button' className='call-indicator-link' onClick={() => open(recording.noteId)}>
          Open
        </button>
        {recording.state !== 'finishing' && (
          <button type='button' className='call-indicator-button' onClick={stop}>
            Stop
          </button>
        )}
      </div>
    );
  }

  // Once the call ends, "From your recent calls" (CallActionsPanel) carries its notes.
  return null;
};

export default CallHomeRow;
