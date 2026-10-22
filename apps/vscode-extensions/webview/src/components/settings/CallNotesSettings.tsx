import React from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { useCallDetection } from '../../hooks/useCallDetection';
import SectionShell from './SectionShell';
import StatusDot from './StatusDot';

/**
 * Settings → Call notes (beta, desktop only). docs/design/call-notes.md.
 * Turns call detection on. When a call is detected (Teams, Zoom, Meet, in an
 * app or a browser), WorkspaceGPT shows an indicator and asks before recording
 * (or, with "Take notes automatically", records and shows it); "Take notes"
 * transcribes the call on this Mac into a call note. Kept to a line per
 * control: the privacy details are in the call prompt, where they matter.
 */
const CallNotesSettings: React.FC = () => {
  const updateConfig = useSettingsStore((s) => s.updateConfig);
  const { enabled, autoRecord, capability, state, recording, model, retryModel } = useCallDetection();
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

  const percent = model?.state === 'downloading' ? Math.floor((model.received / Math.max(1, model.total)) * 100) : 0;

  return (
    <SectionShell storageKey='call-notes' title='Call notes' summary={summary} badge={<span className='beta-badge'>Beta</span>} defaultOpen>
      <div className='settings-form'>
        <ToggleRow
          label='Detect calls'
          hint='Asks to take notes when a call starts, in any app or browser.'
          checked={enabled}
          onChange={(on) => updateConfig('callNotes', 'enabled', on)}
        />
        {enabled && capability?.canRecord && (
          <ToggleRow
            label='Take notes automatically'
            hint='Skips the question. Let others on the call know.'
            checked={autoRecord}
            onChange={(on) => updateConfig('callNotes', 'autoRecord', on)}
          />
        )}
        {enabled && unavailable && <small className='form-text'>{capability?.reason ?? 'Call detection is not available on this machine.'}</small>}
        {enabled && capability?.available && capability.canRecord === false && capability.recordReason && (
          <small className='form-text'>{capability.recordReason}</small>
        )}
        {enabled && capability?.canRecord && model && (
          <small className='form-text'>
            {model.state === 'ready' ? (
              <>
                <StatusDot tone='ok' />
                Transcribed on this Mac. Audio is never saved.
              </>
            ) : model.state === 'downloading' ? (
              <>
                <StatusDot tone='warn' />
                Downloading the speech model… {percent}%
              </>
            ) : (
              <>
                <StatusDot tone='warn' />
                {model.state === 'failed' ? model.error : 'Speech model not downloaded.'}{' '}
                <button type='button' className='link-like' onClick={retryModel}>
                  Download (190 MB)
                </button>
              </>
            )}
          </small>
        )}
      </div>
    </SectionShell>
  );
};

/** A switch with its label and a one-line hint under it. */
const ToggleRow: React.FC<{ label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }> = ({ label, hint, checked, onChange }) => (
  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span>{label}</span>
      <small className='form-text'>{hint}</small>
    </span>
    <span className='toggle-switch'>
      <input type='checkbox' role='switch' checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className='slider round' />
    </span>
  </label>
);

export default CallNotesSettings;
