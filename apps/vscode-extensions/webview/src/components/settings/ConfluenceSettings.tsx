import React, { useEffect, useState, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import {
  clearStatusMessageAfterDelay,
  handleConfluenceActions,
  handleInputChange,
} from './utils';
import { ConfluenceConfig } from '../../types';
import { MESSAGE_TYPES } from '../../constants';

const ConfluenceSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();

  const vscode = VSCodeAPI();
  const confluenceConfig = config.confluence as ConfluenceConfig;

  useEffect(() => {
    // Listen for confluence messages from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        // OAuth
        case MESSAGE_TYPES.CONFLUENCE_OAUTH_SUCCESS:
          batchUpdateConfig('confluence', {
            isAuthenticated: true,
            isConnecting: false,
            siteName: message.site?.name || '',
            cloudId: message.site?.id || '',
            messageType: 'success',
            statusMessage: `Connected to ${message.site?.name || 'Confluence'}`,
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        case MESSAGE_TYPES.CONFLUENCE_OAUTH_ERROR:
          batchUpdateConfig('confluence', {
            isConnecting: false,
            messageType: 'error',
            statusMessage: message.message || 'Authentication failed',
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        case MESSAGE_TYPES.DISCONNECT_CONFLUENCE:
          batchUpdateConfig('confluence', {
            isAuthenticated: false,
            siteName: '',
            cloudId: '',
            spaceKey: '',
            availableSpaces: [],
            isSyncing: false,
            isIndexing: false,
            canResume: false,
            canResumeIndexing: false,
            isSyncCompleted: false,
            isIndexingCompleted: false,
            confluenceSyncProgress: 0,
            confluenceIndexProgress: 0,
            lastSyncTime: '',
            messageType: 'success',
            statusMessage: 'Disconnected from Confluence',
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        case MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES_RESPONSE:
          batchUpdateConfig('confluence', {
            availableSpaces: message.spaces || [],
          });
          break;

        case MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES_ERROR:
          batchUpdateConfig('confluence', {
            messageType: 'error',
            statusMessage: message.message || 'Failed to fetch spaces',
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        // Connection check
        case MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS:
          batchUpdateConfig('confluence', {
            messageType: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        // Sync
        case MESSAGE_TYPES.SYNC_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceSyncProgress: message.progress,
            messageType: 'success',
            isSyncing: message.progress < 100,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            messageType: 'success',
            statusMessage: 'Sync completed successfully',
            confluenceSyncProgress: 100,
            isSyncing: false,
            canResume: false,
            isSyncCompleted: true,
            lastSyncTime: message.lastSyncTime || new Date().toISOString(),
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        case MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: `Sync error: Please verify your connection and try again.`,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_CONFLUENCE_STOP:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: `Sync stopped`,
            canResume: true,
          });
          break;

        // Indexing
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: message.progress,
            messageType: 'success',
            isIndexing: true,
            canResumeIndexing: true,
            isSyncing: false,
            canResume: false,
          });
          break;

        case MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: 100,
            messageType: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
            isSyncing: false,
            canResume: false,
            isIndexingCompleted: true,
          });
          clearStatusMessageAfterDelay(
            'confluence',
            'statusMessage',
          );
          break;

        case MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            isIndexing: false,
            messageType: 'error',
            statusMessage: `Indexing error: ${message.message}`,
            canResumeIndexing: true,
          });
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

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
    setSearchQuery('');
    setIsOpen(false);
  };

  const checkConnection = () => {
    batchUpdateConfig('confluence', {
      messageType: 'success',
      statusMessage: 'Checking connection...',
    });
    handleConfluenceActions.checkConnection(vscode, config);
  };

  const startSync = (forceFull: boolean = false) => {
    batchUpdateConfig('confluence', {
      isSyncing: true,
      confluenceSyncProgress: 0,
      statusMessage: forceFull ? 'Starting full sync process...' : 'Starting sync process...',
      messageType: 'success',
    });
    handleConfluenceActions.startSync(vscode, config, forceFull);
    clearStatusMessageAfterDelay(
      'confluence',
      'statusMessage',
    );
  };

  const resumeSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: true,
      statusMessage: 'Resuming sync process...',
      messageType: 'success',
    });
    handleConfluenceActions.resumeSync(vscode, config);
    clearStatusMessageAfterDelay(
      'confluence',
      'statusMessage',
    );
  };

  const stopSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: false,
      isIndexing: false,
      statusMessage: 'Stopping process...',
      messageType: 'error',
    });
    handleConfluenceActions.stopSync(vscode, config);
    clearStatusMessageAfterDelay(
      'confluence',
      'statusMessage',
    );
  };

  const isAuthenticated = confluenceConfig?.isAuthenticated;
  const hasSpaceSelected = !!confluenceConfig?.spaceKey;

  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredSpaces = confluenceConfig?.availableSpaces?.filter(space =>
    space.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    space.key.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const selectedSpace = confluenceConfig?.availableSpaces?.find(s => s.key === confluenceConfig?.spaceKey);

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>Confluence Integration</h3>
        <label className='toggle-switch'>
          <input
            type='checkbox'
            checked={config.confluence?.isConfluenceEnabled}
            onChange={handleToggleChange}
          />
          <span className='slider round'></span>
        </label>
      </div>
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

              {/* Space Selection (Searchable Dropdown) */}
              <div className='form-group' ref={dropdownRef}>
                <label htmlFor='confluence-space'>Select Space</label>
                <div className="searchable-dropdown-container">
                  <div
                    onClick={() => setIsOpen(!isOpen)}
                    className="searchable-dropdown-trigger"
                  >
                    <span className="trigger-text">
                      {selectedSpace ? `${selectedSpace.name} (${selectedSpace.key})` : '-- Select a space --'}
                    </span>
                    <span className="trigger-arrow">{isOpen ? '▲' : '▼'}</span>
                  </div>

                  {isOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: 0,
                        right: 0,
                        zIndex: 100,
                        background: 'var(--vscode-dropdown-background)',
                        border: '1px solid var(--vscode-dropdown-border)',
                        borderRadius: '4px',
                        marginTop: '4px',
                        maxHeight: '300px',
                        overflowY: 'auto',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                      }}
                    >
                      <input
                        type='text'
                        placeholder='Search spaces...'
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        autoFocus
                        style={{
                          width: 'calc(100% - 16px)',
                          margin: '8px',
                          padding: '6px 8px',
                          background: 'var(--vscode-input-background)',
                          color: 'var(--vscode-input-foreground)',
                          border: '1px solid var(--vscode-input-border)',
                          borderRadius: '4px',
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <ul className="searchable-dropdown-list">
                        <li
                          onClick={() => handleSpaceChange('')}
                          className="searchable-dropdown-item clickable"
                        >
                          <span className="item-subtitle">-- Clear selection --</span>
                        </li>
                        {filteredSpaces.map((space) => (
                          <li
                            key={space.key}
                            onClick={() => handleSpaceChange(space.key)}
                            className={`searchable-dropdown-item ${space.key === confluenceConfig.spaceKey ? 'selected' : ''}`}
                          >
                            <div className="item-title">{space.name}</div>
                            <div className="item-subtitle">{space.key} - {space.type}</div>
                          </li>
                        ))}
                        {filteredSpaces.length === 0 && (
                          <li className="searchable-dropdown-empty">
                            No spaces found...
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              {hasSpaceSelected && (
                <>
                  <div className='button-group'>
                    <button onClick={checkConnection}>Check Connection</button>
                    {(confluenceConfig.isSyncing || confluenceConfig.isIndexing) ? (
                      <button
                        onClick={stopSync}
                        className='stop-sync-button'
                        title='Stop process'
                      >
                        {confluenceConfig.isIndexing ? 'Stop Indexing' : 'Stop Sync'}
                      </button>
                    ) : confluenceConfig.canResume ? (
                      <button
                        onClick={resumeSync}
                        className='resume-sync-button'
                        title='Resume sync process'
                      >
                        Resume Sync
                      </button>
                    ) : (
                      <>
                        <button onClick={() => startSync(false)}>
                          {confluenceConfig.lastSyncTime ? 'Sync Recent Changes' : 'Start Sync'}
                        </button>
                        <button
                          onClick={() => startSync(true)}
                          className='secondary-button'
                          title='Forces a complete fetch and reconstruction of the entire Confluence space index.'
                        >
                          Force Full Re-Sync
                        </button>
                      </>
                    )}
                  </div>

                  {/* Sync Status / Last Sync Time / Progress */}
                  <div className='sync-status-container mt-12'>
                    {(confluenceConfig.isSyncing || confluenceConfig.isIndexing) ? (
                      <div className='active-sync-indicator'>
                        <span className="spinner">🔄</span>
                        {confluenceConfig.isSyncing
                          ? `Syncing... (${confluenceConfig.confluenceSyncProgress || 0}%)`
                          : `Indexing... (${confluenceConfig.confluenceIndexProgress || 0}%)`}
                      </div>
                    ) : confluenceConfig.lastSyncTime ? (
                      <div className='last-sync-time'>
                        Last Sync: {new Date(confluenceConfig.lastSyncTime).toLocaleString()}
                        <span className="next-sync-time">
                          (Next auto-sync at ~{new Date(new Date(confluenceConfig.lastSyncTime).getTime() + 4 * 60 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                        </span>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </>
          )}

          {confluenceConfig.statusMessage && (
            <div
              className={`status-message ${confluenceConfig.messageType === 'success' ? 'success' : 'error'}`}
            >
              {confluenceConfig.statusMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ConfluenceSettings;
