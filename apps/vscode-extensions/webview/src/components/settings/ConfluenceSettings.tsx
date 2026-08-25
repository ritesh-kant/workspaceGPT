import React from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import {
  formatRelativeTime,
  handleConfluenceActions,
  handleInputChange,
} from './utils';
import { ConfluenceConfig } from '../../types';
import SearchableDropdown from './SearchableDropdown';
import SectionShell from './SectionShell';
import SyncControls, { SyncStatusMessage } from './SyncControls';

const ConfluenceSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();

  const vscode = VSCodeAPI();
  const confluenceConfig = config.confluence as ConfluenceConfig;

  // Host messages for this section are handled app-wide in
  // store/settingsMessages.ts — this panel unmounts on every trip back to chat,
  // and sync/OAuth completions are sent exactly once.

  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateConfig('confluence', 'isConfluenceEnabled', e.target.checked);
  };

  const startOAuth = () => {
    batchUpdateConfig('confluence', {
      isConnecting: true,
      statusMessage: 'Opening browser for authentication...',
      messageType: 'success',
    });
    handleConfluenceActions.startOAuth(vscode);
  };

  const cancelOAuth = () => {
    handleConfluenceActions.cancelOAuth(vscode);
    // State will be updated via the response from extension
  };

  const disconnect = () => {
    handleConfluenceActions.disconnect(vscode);
  };

  const handleSpaceChange = (key: string) => {
    handleInputChange('confluence', 'spaceKey', key);
  };

  const isAuthenticated = confluenceConfig?.isAuthenticated;
  const hasSpaceSelected = !!confluenceConfig?.spaceKey;

  const spaceOptions = (confluenceConfig?.availableSpaces ?? []).map((space) => ({
    value: space.key,
    label: space.name,
    subtitle: `${space.key} - ${space.type}`,
  }));

  const isEnabled = !!confluenceConfig?.isConfluenceEnabled;
  const isBusy = !!confluenceConfig?.isSyncing || !!confluenceConfig?.isIndexing;
  const hasError =
    confluenceConfig?.messageType === 'error' && !!confluenceConfig?.statusMessage;

  const summary = !isEnabled
    ? 'Off'
    : !isAuthenticated
      ? 'Not connected'
      : !hasSpaceSelected
        ? 'Connected · no space selected'
        : isBusy
          ? confluenceConfig.isSyncing
            ? `Syncing… ${confluenceConfig.confluenceSyncProgress || 0}%`
            : `Indexing… ${confluenceConfig.confluenceIndexProgress || 0}%`
          : `✅ ${confluenceConfig.siteName || 'Connected'} · ${confluenceConfig.spaceKey} · ${formatRelativeTime(confluenceConfig.lastSyncTime)}`;

  return (
    <SectionShell
      storageKey='confluence'
      title='Confluence'
      summary={summary}
      needsAttention={isEnabled && (!isAuthenticated || !hasSpaceSelected || hasError)}
      headerControl={
        <label className='toggle-switch'>
          <input
            type='checkbox'
            checked={isEnabled}
            onChange={handleToggleChange}
          />
          <span className='slider round'></span>
        </label>
      }
    >
      {confluenceConfig?.isConfluenceEnabled && (
        <div className='settings-form'>

          {/* Not Authenticated State */}
          {!isAuthenticated && (
            <div className='oauth-connect'>
              <p className="description-text">
                Connect your Atlassian account to sync Confluence pages.
              </p>
              <button
                onClick={startOAuth}
                disabled={confluenceConfig?.isConnecting}
                className="primary-button-full"
              >
                {confluenceConfig?.isConnecting ? (
                  <>⏳ Connecting...</>
                ) : (
                  <>🔗 Connect to Confluence</>
                )}
              </button>
              {confluenceConfig?.isConnecting && (
                <button
                  onClick={cancelOAuth}
                  className='secondary-button button-full mt-8'
                >
                  Cancel
                </button>
              )}
            </div>
          )}

          {/* Authenticated State */}
          {isAuthenticated && (
            <>
              {/* Connected Site */}
              <div className="connected-banner">
                <span className="connected-label">
                  ✅ Connected to <strong>{confluenceConfig.siteName || 'Confluence'}</strong>
                </span>
                <button
                  onClick={disconnect}
                  className="disconnect-button"
                >
                  Disconnect
                </button>
              </div>

              {/* Space Selection */}
              <div className='form-group'>
                <label htmlFor='confluence-space'>Select Space</label>
                <SearchableDropdown
                  value={confluenceConfig?.spaceKey ?? ''}
                  options={spaceOptions}
                  onChange={handleSpaceChange}
                  placeholder='-- Select a space --'
                  searchPlaceholder='Search spaces...'
                  clearable
                  clearLabel='-- Clear selection --'
                  emptyLabel='No spaces found...'
                />
              </div>

              {/* Action Buttons + sync status — shared with Azure DevOps */}
              {hasSpaceSelected && <SyncControls section='confluence' />}
            </>
          )}

          <SyncStatusMessage section='confluence' />
        </div>
      )}
    </SectionShell>
  );
};

export default ConfluenceSettings;
