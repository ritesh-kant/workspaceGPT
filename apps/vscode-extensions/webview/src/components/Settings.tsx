import React, { useEffect } from 'react';
import { VSCodeAPI, clearVSCodeState } from '../vscode';
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
  const { config, setConfig, updateConfig, batchUpdateConfig, resetStore } =
    useSettingsStore();

  const { config: modelConfig, handleModelChange } = useModelStore();

  const vscode = VSCodeAPI();

  // Helper function to clear status messages after a timeout
  const clearStatusMessageAfterDelay = (
    section: 'confluence' | 'codebase',
    field: 'statusMessage' | 'connectionStatus',
    value: string | 'unknown',
    delay: number = 2000
  ) => {
    setTimeout(() => {
      batchUpdateConfig(section, {
        [field]: value,
      });
    }, delay);
  };

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

        // case MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS:
        //   console.log('DOWNLOAD IN PROGRESS', message.progress);
        //   batchUpdateModelConfig({
        //     isDownloading: true,
        //     downloadProgress: parseFloat(message.progress) || 0,
        //     downloadStatus: 'downloading',
        //     // avoiding embed models from being selected
        //     selectedModel: message.modelId?.includes('embed')
        //       ? modelConfig.selectedModel
        //       : message.modelId,
        //     downloadDetails: {
        //       current: message.current || '0 MB',
        //       total: message.total || '0 MB',
        //     },
        //   });
        //   break;

        // case MESSAGE_TYPES.MODEL_DOWNLOAD_COMPLETE:
        //   console.log(event);
        //   batchUpdateModelConfig({
        //     isDownloading: false,
        //     downloadProgress: 100,
        //     downloadStatus: 'completed',
        //     // Store available models if provided
        //     ...(message.models && Array.isArray(message.models)
        //       ? {
        //           availableModels: message.models,
        //           selectedModel: message.models[0].model,
        //         }
        //       : {}),
        //   });
        //   break;

        // case MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR:
        //   batchUpdateModelConfig({
        //     isDownloading: false,
        //     downloadStatus: 'error',
        //     errorMessage: message.message,
        //   });
        //   break;

        // Confluence
        case MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS:
          batchUpdateConfig('confluence', {
            connectionStatus: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay(
            'confluence',
            'connectionStatus',
            'unknown'
          );
          break;
        case MESSAGE_TYPES.SYNC_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceSyncProgress: message.progress,
            connectionStatus: 'unknown',
            isSyncing: message.progress < 100,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            connectionStatus: 'success',
            statusMessage: 'Sync completed successfully',
            confluenceSyncProgress: 100,
            isSyncing: false,
            canResume: false,
          });

          // Clear the 'Sync completed successfully' message after 2 seconds
          clearStatusMessageAfterDelay(
            'confluence',
            'connectionStatus',
            'unknown'
          );
          console.log('SYNC_CONFLUENCE_COMPLETE', message);
          break;
        case MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Sync stopped: ${message.message}`,
            canResume: true,
          });
          break;
        case MESSAGE_TYPES.SYNC_CONFLUENCE_STOP:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Sync stopped: Please verify your credentials and try again.`,
            canResume: true,
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

          // Clear the 'Sync completed successfully' message after 2 seconds
          clearStatusMessageAfterDelay(
            'codebase',
            'connectionStatus',
            'unknown'
          );
          break;
        case MESSAGE_TYPES.SYNC_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Sync stopped: ${message.message}`,
          });
          break;

        // Indexing
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: message.progress,
            connectionStatus: 'unknown',
            isIndexing: message.progress < 100,
            canResumeIndexing: true,
          });
          break;
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: 100,
            connectionStatus: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
          });

          // Clear the 'Indexing completed successfully' message after 2 seconds
          clearStatusMessageAfterDelay(
            'confluence',
            'connectionStatus',
            'unknown'
          );
          break;

        case MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Indexing error: ${message.message}`,
            canResumeIndexing: true,
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
    batchUpdateConfig('confluence', {
      connectionStatus: 'unknown',
      statusMessage: 'Checking connection...',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION,
      section: 'confluence',
      config,
    });
  };

  const startSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: true,
      confluenceSyncProgress: 0,
      statusMessage: 'Starting sync process...',
      connectionStatus: 'unknown',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  };

  const retry = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RETRY_OLLAMA_CHECK,
    });
  }

  const resumeSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: true,
      statusMessage: 'Resuming sync process...',
      connectionStatus: 'unknown',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  };

  const stopSync = () => {
    batchUpdateConfig('confluence', {
      isSyncing: false,
      statusMessage: 'Stopping sync process...',
    });
    clearStatusMessageAfterDelay('confluence', 'connectionStatus', 'unknown');
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  };

  // const resumeIndexing = () => {
  //   batchUpdateConfig('confluence', {
  //     isIndexing: true,
  //     statusMessage: 'Resuming indexing process...',
  //     connectionStatus: 'unknown',
  //   });
  //   vscode.postMessage({
  //     type: MESSAGE_TYPES.RESUME_INDEXING_CONFLUENCE,
  //     section: 'confluence',
  //     config,
  //   });
  // };

  const stopCodebaseSync = () => {
    batchUpdateConfig('codebase', {
      isSyncing: false,
      statusMessage: 'Stopping scan process...',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_CODEBASE_SYNC,
      section: 'codebase',
      config,
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
                {modelConfig.availableModels &&
                modelConfig.availableModels.length > 0 ? (
                  // Render options from available models
                  modelConfig.availableModels.map((model) => (
                    <option key={model.model} value={model.model}>
                      {model.name} ({model?.details?.parameter_size})
                    </option>
                  ))
                ) : (
                  // Fallback options if no models are available
                  <>
                    <option value='llama3.2:1b'>llama3.2:1b</option>
                  </>
                )}
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
                    Downloading ({modelConfig?.selectedModel}):{' '}
                    {modelConfig.downloadProgress}%
                    {modelConfig.downloadDetails &&
                      ` (${modelConfig.downloadDetails.current} / ${modelConfig.downloadDetails.total})`}
                  </span>
                </div>
              )}
              {modelConfig.downloadStatus === 'error' && (
                <div className='error-message'>
                  Failed to download model 
                  &nbsp;
                  <button
                    onClick={() =>
                      retry()
                    }
                    className='retry-button'
                    title='Retry connection'
                  >
                    ↻
                  </button>
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
                  {config.confluence.isSyncing ? (
                    <button
                      onClick={stopSync}
                      className='stop-sync-button'
                      disabled={config.confluence.isIndexing}
                    >
                      Stop Sync
                    </button>
                  ) : config.confluence.canResume ? (
                    <button
                      onClick={resumeSync}
                      className='resume-sync-button'
                      disabled={config.confluence.isIndexing}
                    >
                      Resume Sync
                    </button>
                  ) : (
                    <button
                      onClick={startSync}
                      disabled={config.confluence.isIndexing}
                    >
                      Start Sync
                    </button>
                  )}
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
                  disabled={true}
                />
                <span className='slider round'></span>
              </label>
            </div>
            <div className='status-message'>
              🚧 Codebase integration is currently under development
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
                  {config.codebase.isSyncing ? (
                    <button
                      onClick={stopCodebaseSync}
                      className='stop-sync-button'
                    >
                      Stop Scan
                    </button>
                  ) : (
                    <button
                      onClick={startSync}
                      disabled={config.codebase.isSyncing}
                    >
                      Scan Codebase
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      }
      <br />
      <div className='settings-form'>
        <button
          className='secondary-button'
          onClick={() => {
            clearVSCodeState();
            // Reset all store states
            resetStore();
            // Show feedback message
            batchUpdateConfig('confluence', {
              connectionStatus: 'success',
              statusMessage: 'VSCode state reset successfully',
            });
            // Clear the success message after 2 seconds
            clearStatusMessageAfterDelay(
              'confluence',
              'connectionStatus',
              'unknown'
            );
          }}
        >
          Reset VSCode State
        </button>
      </div>
    </div>
  );
};

export default SettingsButton;
