import React from 'react';
import { useCallDetection } from '../hooks/useCallDetection';
import { useSettingsStore } from '../store/settingsStore';
import './CallNotesWelcome.css';

/** One-time, opt-in introduction after desktop setup/sign-in. */
const CallNotesWelcome: React.FC<{ visible: boolean }> = ({ visible }) => {
  const { enabled, capability } = useCallDetection({ control: false });
  const dismissed = useSettingsStore((s) => s.config.callNotes?.introDismissed);
  const batchUpdateConfig = useSettingsStore((s) => s.batchUpdateConfig);

  if (!visible || enabled || dismissed || !capability?.available || !capability.canRecord) return null;

  return (
    <aside className='call-notes-welcome' aria-labelledby='call-notes-welcome-title' aria-live='polite'>
      <div>
        <h2 id='call-notes-welcome-title'>Enable Call notes?</h2>
        <p>Get call transcripts, decisions, and follow-ups. WorkspaceGPT detects calls and asks before taking notes.</p>
        <small>Transcribed on this device; audio is never saved. Summaries use your selected model. Enabling downloads a 190 MB speech model.</small>
      </div>
      <div className='call-notes-welcome-actions'>
        <button type='button' className='call-notes-welcome-enable' onClick={() => batchUpdateConfig('callNotes', {
          enabled: true,
          autoRecord: false,
          introDismissed: true,
        })}>Enable Call notes</button>
        <button type='button' onClick={() => batchUpdateConfig('callNotes', { introDismissed: true })}>Not now</button>
        <small>You can change this in Settings → Call notes.</small>
      </div>
    </aside>
  );
};

export default CallNotesWelcome;
