import React, { useEffect } from 'react';
import { VSCodeAPI } from '../vscode';
import './Settings.css';
import { useSettingsStore, useModelStore } from '../store';
import { MESSAGE_TYPES } from '../constants';

interface SettingsButtonProps {
  isVisible: boolean;
  onClose: () => void;
}

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onClose,
}) => {
  // Use settings store instead of local state
  const { config, setConfig, updateConfig, batchUpdateConfig } =
    useSettingsStore();

  const {
    config: modelConfig,
    updateConfig: updateModelConfig,
    batchUpdateConfig: batchUpdateModelConfig,
  } = useModelStore();

  const vscode = VSCodeAPI();

  useEffect(() => {
    // Request current configuration when component mounts
    vscode.postMessage({ type: 'getSettingsButtonConfig' });

    // Listen for configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      console.log('handleMessage', event);

      switch (message.type) {
        case 'SettingsButtonConfig':
          setConfig(message.config);
          break;

        case MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS:
          console.log('DOWNLOAD IN PROGRESS', message.progress);
          batchUpdateModelConfig({
            isDownloading: true,
            downloadProgress: parseFloat(message.progress) || 0,
            downloadStatus: 'downloading',
            downloadDetails: {
              current: message.current || '0 MB',
              total: message.total || '0 MB',
            },
          });
          break;

        case MESSAGE_TYPES.MODEL_DOWNLOAD_COMPLETE:
          batchUpdateModelConfig({
            isDownloading: false,
            downloadProgress: 100,
            downloadStatus: 'completed',
          });
          break;

        case MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR:
          batchUpdateModelConfig({
            isDownloading: false,
            downloadStatus: 'error',
            errorMessage: message.message,
          });
          break;

        // Confluence
        case MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS:
          batchUpdateConfig('confluence', {
            connectionStatus: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          break;
        case MESSAGE_TYPES.SYNC_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceSyncProgress: message.progress,
            connectionStatus: 'unknown',
            isSyncing: message.progress < 100,
          });
          break;

        case MESSAGE_TYPES.SYNC_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            connectionStatus: 'success',
            statusMessage: 'Sync completed successfully',
            confluenceSyncProgress: 100,
            isSyncing: false,
          });
          console.log('SYNC_CONFLUENCE_COMPLETE', message);
          break;
        case MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Sync error: ${message.message}`,
          });
          break;

        // Codebase
        case MESSAGE_TYPES.SYNC_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseSyncProgress: message.progress,
            connectionStatus: 'unknown',
          });

          if (message.progress >= 100) {
            updateConfig('codebase', 'isSyncing', false);
          }
          break;
        case MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            codebaseSyncProgress: 100,
            connectionStatus: 'success',
            statusMessage: 'Sync completed successfully',
          });
          break;
        case MESSAGE_TYPES.SYNC_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Sync error: ${message.message}`,
          });
          break;

        // Indexing
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: message.progress,
            connectionStatus: 'unknown',
            isIndexing: message.progress < 100,
          });
          break;
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: 100,
            connectionStatus: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
          });
          break;

        case MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Indexing error: ${message.message}`,
          });
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleInputChange = (
    section: 'confluence' | 'codebase',
    field: string,
    value: string
  ) => {
    console.log('handleInputChange', section, field, value, config);
    const updatedConfig = {
      ...config,
      [section]: {
        ...config[section],
        [field]: value,
      },
    };
    setConfig(updatedConfig);
  };

  const checkConnection = () => {
    updateConfig('confluence', 'connectionStatus', 'unknown');
    updateConfig('confluence', 'statusMessage', 'Checking connection...');
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION,
      section: 'confluence',
      config,
    });
  };

  const startSync = () => {
    updateConfig('confluence', 'isSyncing', true);
    updateConfig('confluence', 'confluenceSyncProgress', 0);
    updateConfig('confluence', 'statusMessage', 'Starting sync process...');
    updateConfig('confluence', 'connectionStatus', 'unknown');
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  };

  const handleModelChange = (modelId: string) => {
    updateModelConfig('selectedModel', modelId);
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_MODEL,
      modelId,
    });
  };

  if (!isVisible) return null;

  return (
    <div className='settings-panel'>
      <div className='settings-header'>
        <h2>Settings</h2>
        <button
          className='close-button'
          onClick={onClose}
          aria-label='Close settings'
        >
          ×
        </button>
      </div>

      <div className='settings-section'>
        <div className='section-header'>
          <h3>Model Settings</h3>
        </div>
        <div className='settings-form'>
          <div className='form-group'>
            <label htmlFor='model-select'>Select Model</label>
            <div className='model-select-container'>
              <select
                id='model-select'
                className='select-larger'
                value={modelConfig.selectedModel}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={modelConfig.isDownloading}
              >
                <option value='Xenova/TinyLlama-1.1B-Chat-v1.0'>
                  TinyLlama 1.1B Chat
                </option>
                <option value='Xenova/Phi-2'>Phi-2</option>
                <option value='Xenova/CodeLlama-7B-Instruct'>
                  CodeLlama 7B Instruct
                </option>
              </select>
              {modelConfig.isDownloading && (
                <div className='model-download-status'>
                  <div className='progress-bar'>
                    <div
                      className='progress-fill'
                      style={{
                        width: `${modelConfig.downloadProgress}%`,
                      }}
                    ></div>
                  </div>
                  <span className='progress-text'>
                    Downloading: {modelConfig.downloadProgress}%
                    {modelConfig.downloadDetails &&
                      ` (${modelConfig.downloadDetails.current} / ${modelConfig.downloadDetails.total})`}
                  </span>
                </div>
              )}
              {modelConfig.downloadStatus === 'error' && (
                <div className='error-message'>
                  {modelConfig.errorMessage || 'Failed to download model'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <br />

      {
        <>
          <div className='settings-section'>
            <div className='section-header'>
              <h3>Confluence Integration</h3>
              <label className='toggle-switch'>
                <input
                  type='checkbox'
                  checked={config.confluence.isConfluenceEnabled}
                  onChange={() =>
                    updateConfig(
                      'confluence',
                      'isConfluenceEnabled',
                      !config.confluence.isConfluenceEnabled
                    )
                  }
                />
                <span className='slider round'></span>
              </label>
            </div>
            {config.confluence.isConfluenceEnabled && (
              <div className='settings-form'>
                <div className='form-group'>
                  <label htmlFor='confluence-base-url'>
                    Confluence Base URL
                  </label>
                  <input
                    id='confluence-base-url'
                    type='text'
                    value={config.confluence?.baseUrl}
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
                    value={config.confluence?.spaceKey}
                    onChange={(e) =>
                      handleInputChange(
                        'confluence',
                        'spaceKey',
                        e.target.value
                      )
                    }
                    placeholder='SPACE'
                  />
                </div>

                <div className='form-group'>
                  <label htmlFor='confluence-user-email'>User Email</label>
                  <input
                    id='confluence-user-email'
                    type='email'
                    value={config.confluence?.userEmail}
                    onChange={(e) =>
                      handleInputChange(
                        'confluence',
                        'userEmail',
                        e.target.value
                      )
                    }
                    placeholder='your.email@example.com'
                  />
                </div>

                <div className='form-group'>
                  <label htmlFor='confluence-api-token'>API Token</label>
                  <input
                    id='confluence-api-token'
                    type='password'
                    value={config.confluence?.apiToken}
                    onChange={(e) =>
                      handleInputChange(
                        'confluence',
                        'apiToken',
                        e.target.value
                      )
                    }
                    placeholder='Your Atlassian API token'
                  />
                </div>

                <div className='button-group'>
                  <button onClick={checkConnection}>Check Connection</button>
                  <button
                    onClick={startSync}
                    // disabled={isConfluenceSyncing || connectionStatus !== 'success'}
                  >
                    Start Sync
                  </button>
                </div>

                {config.confluence.connectionStatus !== 'unknown' && (
                  <div
                    className={`status-message ${config.confluence.connectionStatus}`}
                  >
                    {config.confluence.statusMessage}
                  </div>
                )}

                {config.confluence.isSyncing && (
                  <div className='sync-progress'>
                    <div className='progress-label'>
                      Syncing: {config.confluence.confluenceSyncProgress}%
                    </div>
                    <div className='progress-bar'>
                      <div
                        className='progress-fill'
                        style={{
                          width: `${config.confluence.confluenceSyncProgress}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                )}
                {config.confluence.isIndexing && (
                  <div className='sync-progress'>
                    <div className='progress-label'>
                      Indexing: {config.confluence.confluenceIndexProgress}%
                    </div>
                    <div className='progress-bar'>
                      <div
                        className='progress-fill'
                        style={{
                          width: `${config.confluence.confluenceIndexProgress}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <br />
          <div className='settings-section'>
            <div className='section-header'>
              <h3>Codebase Integration</h3>
              <label className='toggle-switch'>
                <input
                  type='checkbox'
                  checked={config.codebase.isCodebaseEnabled}
                  onChange={() =>
                    updateConfig(
                      'codebase',
                      'isCodebaseEnabled',
                      !config.codebase.isCodebaseEnabled
                    )
                  }
                />
                <span className='slider round'></span>
              </label>
            </div>
            {config.codebase.isCodebaseEnabled && (
              <div className='settings-form'>
                <div className='form-group'>
                  <label htmlFor='codebase-repo-path'>Repository Path</label>
                  <input
                    id='codebase-repo-path'
                    type='text'
                    value={config.codebase?.repoPath}
                    onChange={(e) =>
                      handleInputChange('codebase', 'repoPath', e.target.value)
                    }
                    placeholder='/path/to/your/repository'
                  />
                </div>

                <div className='form-group'>
                  <label htmlFor='codebase-scan-frequency'>
                    Scan Frequency
                  </label>
                  <select
                    id='codebase-scan-frequency'
                    className='select-larger'
                    value={config.codebase?.scanFrequency}
                    onChange={(e) =>
                      handleInputChange(
                        'codebase',
                        'scanFrequency',
                        e.target.value
                      )
                    }
                  >
                    <option value='hourly'>Hourly</option>
                    <option value='daily'>Daily</option>
                    <option value='weekly'>Weekly</option>
                  </select>
                </div>

                <div className='button-group'>
                  <button
                    onClick={startSync}
                    disabled={config.codebase.isSyncing}
                  >
                    Scan Codebase
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      }
    </div>
  );
};

export default SettingsButton;
