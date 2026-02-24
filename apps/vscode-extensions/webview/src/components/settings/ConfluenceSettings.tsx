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
            isIndexing: message.progress < 100,
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

  const startSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: true,
      confluenceSyncProgress: 0,
      statusMessage: 'Starting sync process...',
      messageType: 'success',
    });
    handleConfluenceActions.startSync(vscode, config);
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
      statusMessage: 'Stopping sync process...',
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
              <p style={{ color: '#a0a0a0', marginBottom: '12px', fontSize: '0.9em' }}>
                Connect your Atlassian account to sync Confluence pages.
              </p>
              <button
                onClick={startOAuth}
                disabled={confluenceConfig?.isConnecting}
                style={{
                  width: '100%',
                  padding: '10px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                {confluenceConfig?.isConnecting ? (
                  <>⏳ Connecting...</>
                ) : (
                  <>🔗 Connect to Confluence</>
                )}
              </button>
            </div>
          )}

          {/* Authenticated State */}
          {isAuthenticated && (
            <>
              {/* Connected Site */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                background: 'rgba(78, 204, 163, 0.1)',
                borderRadius: '6px',
                marginBottom: '12px',
                border: '1px solid rgba(78, 204, 163, 0.2)',
              }}>
                <span style={{ color: '#4ecca3', fontSize: '0.9em' }}>
                  ✅ Connected to <strong>{confluenceConfig.siteName || 'Confluence'}</strong>
                </span>
                <button
                  onClick={disconnect}
                  style={{
                    padding: '4px 10px',
                    fontSize: '0.8em',
                    background: 'rgba(231, 76, 60, 0.15)',
                    color: '#e74c3c',
                    border: '1px solid rgba(231, 76, 60, 0.3)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Disconnect
                </button>
              </div>

              {/* Space Selection (Searchable Dropdown) */}
              <div className='form-group' ref={dropdownRef}>
                <label htmlFor='confluence-space'>Select Space</label>
                <div style={{ position: 'relative', width: '100%' }}>
                  <div
                    onClick={() => setIsOpen(!isOpen)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: 'var(--vscode-input-background)',
                      color: 'var(--vscode-input-foreground)',
                      border: '1px solid var(--vscode-input-border)',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {selectedSpace ? `${selectedSpace.name} (${selectedSpace.key})` : '-- Select a space --'}
                    </span>
                    <span>{isOpen ? '▲' : '▼'}</span>
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
                      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                        <li
                          onClick={() => handleSpaceChange('')}
                          style={{
                            padding: '8px 12px',
                            cursor: 'pointer',
                            color: 'var(--vscode-descriptionForeground)',
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        >
                          -- Clear selection --
                        </li>
                        {filteredSpaces.map((space) => (
                          <li
                            key={space.key}
                            onClick={() => handleSpaceChange(space.key)}
                            style={{
                              padding: '8px 12px',
                              cursor: 'pointer',
                              background:
                                space.key === confluenceConfig.spaceKey
                                  ? 'var(--vscode-list-activeSelectionBackground)'
                                  : 'transparent',
                              color:
                                space.key === confluenceConfig.spaceKey
                                  ? 'var(--vscode-list-activeSelectionForeground)'
                                  : 'var(--vscode-dropdown-foreground)',
                            }}
                            onMouseEnter={(e) => {
                              if (space.key !== confluenceConfig.spaceKey) {
                                e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (space.key !== confluenceConfig.spaceKey) {
                                e.currentTarget.style.background = 'transparent';
                              }
                            }}
                          >
                            <div style={{ fontWeight: 'bold' }}>{space.name}</div>
                            <div style={{ fontSize: '0.85em', opacity: 0.8 }}>{space.key} - {space.type}</div>
                          </li>
                        ))}
                        {filteredSpaces.length === 0 && (
                          <li style={{ padding: '8px 12px', color: 'var(--vscode-descriptionForeground)' }}>
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
                    {confluenceConfig.isSyncing ? (
                      <button
                        onClick={stopSync}
                        className='stop-sync-button'
                        title='Stop sync process'
                      >
                        Stop Sync
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
                      <button onClick={startSync}>Start Sync</button>
                    )}
                  </div>

                  {/* Last Sync Time */}
                  {confluenceConfig.lastSyncTime && (
                    <div className='last-sync-time' style={{ marginTop: '8px', color: '#888', fontSize: '0.95em' }}>
                      Last Sync: {new Date(confluenceConfig.lastSyncTime).toLocaleString()}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Progress bars and status messages */}
          <div className='progress-container'>
            {confluenceConfig.isSyncing && (
              <>
                <div className='progress-bar'>
                  <div
                    className='progress-fill'
                    style={{
                      width: `${confluenceConfig.confluenceSyncProgress}%`,
                    }}
                  />
                </div>
                <span className='progress-text'>
                  Sync Progress: {confluenceConfig.confluenceSyncProgress}%
                </span>
              </>
            )}
            {confluenceConfig.isIndexing && (
              <>
                <div className='progress-bar'>
                  <div
                    className='progress-fill'
                    style={{
                      width: `${confluenceConfig.confluenceIndexProgress}%`,
                    }}
                  />
                </div>
                <span className='progress-text'>
                  Index Progress: {confluenceConfig.confluenceIndexProgress}%
                </span>
              </>
            )}
          </div>

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
