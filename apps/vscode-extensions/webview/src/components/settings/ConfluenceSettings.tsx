import React from 'react';
import { useEffect } from 'react';
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
    // Listen for confluence configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS:
          batchUpdateConfig('confluence', {
            messageType: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

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
          });
          clearStatusMessageAfterDelay('confluence', 'statusMessage');
          break;

        case MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: `Sync error: Please verify your credentials and try again.`,
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
  };

  const resumeSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: true,
      statusMessage: 'Resuming sync process...',
      messageType: 'success',
    });
    handleConfluenceActions.resumeSync(vscode, config);
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
          <div className='form-group'>
            <label htmlFor='confluence-base-url'>Confluence Base URL</label>
            <input
              id='confluence-base-url'
              type='text'
              value={confluenceConfig?.baseUrl}
              onChange={(e) =>
                handleInputChange('confluence', 'baseUrl', e.target.value)
              }
              placeholder='https://your-domain.atlassian.net'
            />
          </div>

          <div className='form-group'>
            <label htmlFor='confluence-space-key'>Space Key</label>
            <input
              id='confluence-space-key'
              type='text'
              value={confluenceConfig?.spaceKey}
              onChange={(e) =>
                handleInputChange('confluence', 'spaceKey', e.target.value)
              }
              placeholder='SPACE'
            />
          </div>

          <div className='form-group'>
            <label htmlFor='confluence-user-email'>User Email</label>
            <input
              id='confluence-user-email'
              type='email'
              value={confluenceConfig?.userEmail}
              onChange={(e) =>
                handleInputChange('confluence', 'userEmail', e.target.value)
              }
              placeholder='your.email@example.com'
            />
          </div>

          <div className='form-group'>
            <label htmlFor='confluence-api-token'>
              API Token
              <a
                href='https://id.atlassian.com/manage-profile/security/api-tokens'
                target='_blank'
                rel='noopener noreferrer'
                className='help-link'
                title='Get your Atlassian API token'
              >
                (help)
              </a>
            </label>
            <input
              id='confluence-api-token'
              type='password'
              value={confluenceConfig?.apiToken}
              onChange={(e) =>
                handleInputChange('confluence', 'apiToken', e.target.value)
              }
              placeholder='Your Atlassian API token'
            />
          </div>

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

          {/* Progress bars and status messages */}
          <div className='progress-container'>
            {confluenceConfig.isSyncing && (
              <div className='progress-bar'>
                <div
                  className='progress-fill'
                  style={{
                    width: `${confluenceConfig.confluenceSyncProgress}%`,
                  }}
                />
                <span className='progress-text'>
                  Sync Progress: {confluenceConfig.confluenceSyncProgress}%
                </span>
              </div>
            )}
            {confluenceConfig.isIndexing && (
              <div className='progress-bar'>
                <div
                  className='progress-fill'
                  style={{
                    width: `${confluenceConfig.confluenceIndexProgress}%`,
                  }}
                />
                <span className='progress-text'>
                  Index Progress: {confluenceConfig.confluenceIndexProgress}%
                </span>
              </div>
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
