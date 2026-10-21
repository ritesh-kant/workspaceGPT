import React from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { useCallDetection } from '../../hooks/useCallDetection';
import SectionShell from './SectionShell';
import StatusDot from './StatusDot';

/**
 * Settings → Call notes (beta, desktop only). docs/design/call-notes.md.
 * Turns call detection on. When a call is detected (Teams, Zoom, Meet, in an
 * app or a browser), WorkspaceGPT shows an indicator and asks before recording;
 * "Take notes" transcribes the call on this Mac into a call note.
 */
const CallNotesSettings: React.FC = () => {
  const updateConfig = useSettingsStore((s) => s.updateConfig);
  const { enabled, capability, state, recording } = useCallDetection();
  const unavailable = capability && !capability.available;

  const summary = !enabled ? (
    'Off'
  ) : unavailable ? (
    <>
      <StatusDot tone='warn' />
      Not available here
    </>
  ) : recording ? (
    <>
      <StatusDot tone='ok' />
      Taking notes now
    </>
  ) : state.inCall ? (
    <>
      <StatusDot tone='ok' />
      In a call now
    </>
  ) : (
    <>
      <StatusDot tone='ok' />
      On · no call right now
    </>
  );

  return (
    <SectionShell storageKey='call-notes' title='Call notes' summary={summary} badge={<span className='beta-badge'>Beta</span>} defaultOpen>
      <div className='settings-form'>
        <small className='form-text'>
          Notices when you are in a call (Teams, Zoom, Meet or any other, in an app or a browser) and asks whether to take notes. Nothing is recorded unless you
          choose to, and detection only looks at whether an app is using your microphone; it never listens.
        </small>
        <div className='form-group'>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>Detect calls and ask to take notes</span>
            <span className='toggle-switch'>
              <input
                type='checkbox'
                role='switch'
                checked={enabled}
                aria-label='Detect calls and ask to take notes'
                onChange={(e) => updateConfig('callNotes', 'enabled', e.target.checked)}
              />
              <span className='slider round' />
            </span>
          </label>
        </div>
        {enabled && unavailable && <small className='form-text'>{capability?.reason ?? 'Call detection is not available on this machine.'}</small>}
        {enabled && capability?.available && capability.canRecord === false && capability.recordReason && (
          <small className='form-text'>{capability.recordReason}</small>
        )}
        <small className='form-text'>
          “Take notes” transcribes your microphone (“You”) and the call’s own audio (“Others”) on this Mac. Only the text is kept, on this machine; the audio is
          never saved. Notes appear under Call notes in the sidebar, and chats can search them. The first time, macOS asks to allow Speech Recognition, the
          Microphone and System Audio Recording. If you take notes, let everyone on the call know.
        </small>
      </div>
    </SectionShell>
  );
};

export default CallNotesSettings;
