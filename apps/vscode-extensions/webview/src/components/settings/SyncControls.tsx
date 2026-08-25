import React from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES, SYNC_INTERVAL_MS } from '../../constants';
import { clearStatusMessageAfterDelay } from '../../store/statusMessage';

export type SyncSection = 'confluence' | 'ado';

/**
 * Per-section wire protocol and progress field names. Everything else about
 * syncing — the buttons, the progress line, the "next auto-sync" footer, the
 * optimistic status updates — is identical between the two integrations, and
 * used to exist as two copies that quietly drifted apart.
 */
const SECTIONS: Record<
  SyncSection,
  {
    check: string;
    start: string;
    resume: string;
    stop: string;
    syncProgress: 'confluenceSyncProgress' | 'adoSyncProgress';
    indexProgress: 'confluenceIndexProgress' | 'adoIndexProgress';
  }
> = {
  confluence: {
    check: MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION,
    start: MESSAGE_TYPES.START_CONFLUENCE_SYNC,
    resume: MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC,
    stop: MESSAGE_TYPES.STOP_CONFLUENCE_SYNC,
    syncProgress: 'confluenceSyncProgress',
    indexProgress: 'confluenceIndexProgress',
  },
  ado: {
    check: MESSAGE_TYPES.CHECK_ADO_CONNECTION,
    start: MESSAGE_TYPES.START_ADO_SYNC,
    resume: MESSAGE_TYPES.RESUME_ADO_SYNC,
    stop: MESSAGE_TYPES.STOP_ADO_SYNC,
    syncProgress: 'adoSyncProgress',
    indexProgress: 'adoIndexProgress',
  },
};

/**
 * Sync actions for one integration: optimistic store update, then the host
 * message. The host's replies are handled app-wide in store/settingsMessages.
 */
export function useSyncActions(section: SyncSection) {
  const vscode = VSCodeAPI();
  const fields = SECTIONS[section];

  const post = (type: string, extra: Record<string, unknown> = {}) => {
    const config = useSettingsStore.getState().config;
    vscode.postMessage({ type, section, config, ...extra });
  };

  const update = (patch: Record<string, unknown>) =>
    useSettingsStore.getState().batchUpdateConfig(section, patch);

  return {
    checkConnection: () => {
      update({ messageType: 'success', statusMessage: 'Checking connection...' });
      post(fields.check);
    },
    startSync: (forceFull: boolean = false) => {
      update({
        isSyncing: true,
        [fields.syncProgress]: 0,
        statusMessage: forceFull ? 'Starting full sync process...' : 'Starting sync process...',
        messageType: 'success',
      });
      post(fields.start, { forceFull });
      clearStatusMessageAfterDelay(section);
    },
    resumeSync: () => {
      update({ isSyncing: true, statusMessage: 'Resuming sync process...', messageType: 'success' });
      post(fields.resume);
      clearStatusMessageAfterDelay(section);
    },
    stopSync: () => {
      update({
        isSyncing: false,
        isIndexing: false,
        statusMessage: 'Stopping process...',
        messageType: 'error',
      });
      post(fields.stop);
      clearStatusMessageAfterDelay(section);
    },
  };
}

/**
 * The sync button row plus the progress / last-synced line, shared by the
 * Confluence and Azure DevOps sections.
 */
const SyncControls: React.FC<{ section: SyncSection }> = ({ section }) => {
  const { config } = useSettingsStore();
  const fields = SECTIONS[section];
  const sectionConfig = (config[section] ?? {}) as Record<string, any>;
  const { checkConnection, startSync, resumeSync, stopSync } = useSyncActions(section);

  const isSyncing = !!sectionConfig.isSyncing;
  const isIndexing = !!sectionConfig.isIndexing;
  const lastSyncTime = sectionConfig.lastSyncTime as string | undefined;

  return (
    <>
      <div className='button-group'>
        <button onClick={checkConnection}>Check Connection</button>
        {isSyncing || isIndexing ? (
          <button onClick={stopSync} className='stop-sync-button' title='Stop process'>
            {isIndexing ? 'Stop Indexing' : 'Stop Sync'}
          </button>
        ) : sectionConfig.canResume ? (
          <button onClick={resumeSync} className='resume-sync-button' title='Resume sync process'>
            Resume Sync
          </button>
        ) : (
          <>
            <button onClick={() => startSync(false)}>
              {lastSyncTime ? 'Sync Recent Changes' : 'Start Sync'}
            </button>
            {/* Only meaningful once something has been synced — before that,
                "Start Sync" already fetches everything. */}
            {lastSyncTime && (
              <button
                onClick={() => startSync(true)}
                className='secondary-button'
                title='Forces a complete re-fetch and rebuild of the index for this source.'
              >
                Force Full Re-Sync
              </button>
            )}
          </>
        )}
      </div>

      <div className='sync-status-container mt-12'>
        {isSyncing || isIndexing ? (
          <div className='active-sync-indicator'>
            <span className='spinner'>
              <svg
                viewBox='0 0 24 24'
                fill='none'
                xmlns='http://www.w3.org/2000/svg'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M21 12a9 9 0 1 1-6.219-8.56' />
              </svg>
            </span>
            {isSyncing
              ? `Syncing... (${sectionConfig[fields.syncProgress] || 0}%)`
              : `Indexing... (${sectionConfig[fields.indexProgress] || 0}%)`}
          </div>
        ) : lastSyncTime ? (
          <div className='last-sync-time'>
            Last Sync: {new Date(lastSyncTime).toLocaleString()}
            <span className='next-sync-time'>
              (Next auto-sync at ~
              {new Date(new Date(lastSyncTime).getTime() + SYNC_INTERVAL_MS).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              )
            </span>
          </div>
        ) : null}
      </div>
    </>
  );
};

/** The section's transient status line, shared by both integrations. */
export const SyncStatusMessage: React.FC<{ section: SyncSection }> = ({ section }) => {
  const { config } = useSettingsStore();
  const sectionConfig = (config[section] ?? {}) as Record<string, any>;
  if (!sectionConfig.statusMessage) return null;

  return (
    <div
      className={`status-message ${sectionConfig.messageType === 'success' ? 'success' : 'error'}`}
    >
      {sectionConfig.statusMessage}
    </div>
  );
};

export default SyncControls;
