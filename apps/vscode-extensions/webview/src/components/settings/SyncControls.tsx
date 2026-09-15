import React, { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES, SYNC_INTERVAL_MS } from '../../constants';
import { clearStatusMessageAfterDelay } from '../../store/statusMessage';
import { formatRelativeTime } from './utils';

export type SyncSection = 'confluence' | 'ado' | 'jira';

/**
 * Per-section wire protocol and progress field names. Everything else about
 * syncing — the buttons, the progress line, the "next auto-sync" footer, the
 * optimistic status updates — is identical between the integrations, and used
 * to exist as separate copies that quietly drifted apart.
 */
const SECTIONS: Record<
  SyncSection,
  {
    check: string;
    start: string;
    resume: string;
    stop: string;
    syncProgress: 'confluenceSyncProgress' | 'adoSyncProgress' | 'jiraSyncProgress';
    indexProgress: 'confluenceIndexProgress' | 'adoIndexProgress' | 'jiraIndexProgress';
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
  jira: {
    check: MESSAGE_TYPES.CHECK_JIRA_CONNECTION,
    start: MESSAGE_TYPES.START_JIRA_SYNC,
    resume: MESSAGE_TYPES.RESUME_JIRA_SYNC,
    stop: MESSAGE_TYPES.STOP_JIRA_SYNC,
    syncProgress: 'jiraSyncProgress',
    indexProgress: 'jiraIndexProgress',
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

const AUTO_SYNC_MINUTES = Math.round(SYNC_INTERVAL_MS / 60_000);

/**
 * The rarely-needed actions, behind one "more" button. "Check connection" is
 * redundant while the banner above already says connected, and a full re-sync
 * is a recovery tool, not a daily one — neither earns a primary button.
 */
const SyncOverflowMenu: React.FC<{
  onCheckConnection: () => void;
  onForceFullSync?: () => void;
}> = ({ onCheckConnection, onForceFullSync }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className='sync-overflow' ref={ref}>
      <button
        type='button'
        className='sync-overflow-trigger'
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-label='More sync options'
        data-tooltip='More'
      >
        <svg width='16' height='16' viewBox='0 0 24 24' fill='currentColor' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
          <circle cx='5' cy='12' r='2' />
          <circle cx='12' cy='12' r='2' />
          <circle cx='19' cy='12' r='2' />
        </svg>
      </button>
      {open && (
        <div className='sync-overflow-menu' role='menu'>
          <button type='button' role='menuitem' onClick={() => run(onCheckConnection)}>
            Check connection
          </button>
          {onForceFullSync && (
            <button type='button' role='menuitem' onClick={() => run(onForceFullSync)}>
              <span>Full re-sync</span>
              <span className='sync-overflow-hint'>Re-fetches everything and rebuilds the index</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Re-render once a minute so the relative "synced Nm ago" label ages on its
 * own. `formatRelativeTime` reads `Date.now()` at render time, and the panel
 * can stay mounted for hours (`retainContextWhenHidden`), so without a tick the
 * label freezes at whatever it read the last time something else happened to
 * re-render it.
 */
function useMinuteTick(enabled: boolean): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [enabled]);
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

  // Only while the relative label is the thing on screen.
  useMinuteTick(!!lastSyncTime && !isSyncing && !isIndexing);

  return (
    <>
      <div className='sync-row'>
        {isSyncing || isIndexing ? (
          <button onClick={stopSync} className='sync-primary stop-sync-button' title='Stop process'>
            {isIndexing ? 'Stop indexing' : 'Stop sync'}
          </button>
        ) : sectionConfig.canResume ? (
          <button onClick={resumeSync} className='sync-primary resume-sync-button' title='Resume sync process'>
            Resume sync
          </button>
        ) : (
          <button onClick={() => startSync(false)} className='sync-primary'>
            {lastSyncTime ? 'Sync now' : 'Start sync'}
          </button>
        )}
        {!(isSyncing || isIndexing) && (
          <SyncOverflowMenu
            onCheckConnection={checkConnection}
            // Only meaningful once something has been synced — before that,
            // "Start sync" already fetches everything.
            onForceFullSync={lastSyncTime ? () => startSync(true) : undefined}
          />
        )}
      </div>

      <div className='sync-status-container'>
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
              ? `Syncing… ${sectionConfig[fields.syncProgress] || 0}%`
              : `Indexing… ${sectionConfig[fields.indexProgress] || 0}%`}
          </div>
        ) : lastSyncTime ? (
          <div className='last-sync-time'>
            {capitalize(formatRelativeTime(lastSyncTime))}
            <span className='next-sync-time'> · auto-syncs every {AUTO_SYNC_MINUTES} min</span>
          </div>
        ) : null}
      </div>
    </>
  );
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

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
