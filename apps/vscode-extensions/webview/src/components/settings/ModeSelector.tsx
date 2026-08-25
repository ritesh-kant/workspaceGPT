import React, { useState } from 'react';
import { useSettingsStore } from '../../store';
import { WorkspaceMode } from '../../constants';
import SectionShell from './SectionShell';

const MODE_COPY: Record<WorkspaceMode, { title: string; description: string }> = {
  local: {
    title: 'Local',
    description: 'Bring your own chat model. Embeddings and the search index stay on this machine.',
  },
  remote: {
    title: 'Remote',
    description: 'Managed chat models. Embeddings and the search index run in the cloud — enables Share to Chrome.',
  },
};

/**
 * The single mode switch at the top of Settings. Everything else in the panel
 * (which sections render, whether the model picker shows, whether Share to
 * Chrome is available) follows from this one choice — see `config.mode` in
 * settingsStore. Switching shows a lightweight confirmation (the actual
 * re-index prompt, if any connected source needs one, comes from the
 * extension host once the new mode is persisted).
 */
const ModeSelector: React.FC = () => {
  const { config, setMode } = useSettingsStore();
  const mode = config.mode;
  const [pendingMode, setPendingMode] = useState<WorkspaceMode | null>(null);

  const syncBusy =
    !!config.confluence?.isSyncing ||
    !!config.confluence?.isIndexing ||
    !!config.ado?.isSyncing ||
    !!config.ado?.isIndexing;

  const requestSwitch = (next: WorkspaceMode) => {
    if (next === mode || syncBusy) return;
    setPendingMode(next);
  };

  const confirmSwitch = () => {
    if (pendingMode) setMode(pendingMode);
    setPendingMode(null);
  };

  // A workspace with nothing connected yet is still being set up, and mode is
  // the first decision — show it expanded. Once a source is connected, the
  // switch is rarely touched and collapses to its one-word summary.
  const isFreshInstall =
    !config.confluence?.isAuthenticated && !config.ado?.isAuthenticated;

  return (
    <SectionShell
      storageKey='mode'
      title='Mode'
      summary={MODE_COPY[mode].title}
      defaultOpen={isFreshInstall}
    >
      <div className='settings-form'>
        <div className='mode-card-row'>
          {(Object.keys(MODE_COPY) as WorkspaceMode[]).map((m) => (
            <button
              type='button'
              key={m}
              className={`mode-card${mode === m ? ' mode-card--active' : ''}`}
              onClick={() => requestSwitch(m)}
              disabled={syncBusy && mode !== m}
              data-tooltip={syncBusy && mode !== m ? 'Wait for the current sync to finish' : undefined}
            >
              <span className='mode-card-title'>{MODE_COPY[m].title}</span>
              <span className='mode-card-desc'>{MODE_COPY[m].description}</span>
            </button>
          ))}
        </div>
      </div>

      {pendingMode && (
        <div className='mode-confirm-overlay' role='dialog' aria-modal='true'>
          <div className='mode-confirm-dialog'>
            <p>
              Switch to <strong>{MODE_COPY[pendingMode].title}</strong> mode?{' '}
              {pendingMode === 'remote'
                ? 'Chat, embeddings, and the search index move to managed cloud services.'
                : 'Chat, embeddings, and the search index move back to this machine.'}{' '}
              Any connected source will need to be re-indexed.
            </p>
            <div className='mode-confirm-actions'>
              <button type='button' className='secondary-button' onClick={() => setPendingMode(null)}>
                Cancel
              </button>
              <button type='button' className='primary-button' onClick={confirmSwitch}>
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </SectionShell>
  );
};

export default ModeSelector;
