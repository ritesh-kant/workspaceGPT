import React, { useEffect } from 'react';
import { VSCodeAPI, clearVSCodeState } from '../vscode';
import './Settings.css';
import { useSettingsStore, useModelStore, useChatStore } from '../store';
import { MESSAGE_TYPES } from '../constants';

interface SettingsButtonProps {
  isVisible: boolean;
  onBack: () => void;
}

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onBack,
}) => {
  // Use settings store instead of local state
  const {
    config,
    setConfig,
    updateConfig,
    batchUpdateConfig,
    resetStore: resetSettingStore,
  } = useSettingsStore();

  const {
    config: modelConfig,
    handleModelChange,
    resetStore: resetModelStore,
  } = useModelStore();

  const { resetStore: resetChatStore } = useChatStore();

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
      // console.log('handleMessage', event);

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
            isSyncCompleted: true,
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
            statusMessage: `Sync error: Please verify your credentials and try again.`,
            canResume: true,
          });
          break;
        case MESSAGE_TYPES.SYNC_CONFLUENCE_STOP:
          batchUpdateConfig('confluence', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Sync stopped`,
            canResume: true,
          });
          break;

        // Codebase
        case MESSAGE_TYPES.SYNC_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseSyncProgress: message.progress,
            connectionStatus: 'unknown',
            isSyncing: message.progress < 100,
            canResume: true,
          });
          break;
        case MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            codebaseSyncProgress: 100,
            connectionStatus: 'success',
            statusMessage: 'Sync completed successfully',
            canResume: false,
            isSyncCompleted: true,
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
            statusMessage: `Sync error: ${message.message}`,
            canResume: true,
          });
          break;
        case MESSAGE_TYPES.CODEBASE_CONNECTION_STATUS:
          batchUpdateConfig('codebase', {
            connectionStatus: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'connectionStatus',
            'unknown'
          );
          break;

        // Codebase Indexing
        case MESSAGE_TYPES.INDEXING_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseIndexProgress: message.progress,
            connectionStatus: 'unknown',
            isIndexing: message.progress < 100,
            canResumeIndexing: true,
            isSyncing: false,
            canResume: false,
          });
          break;
        case MESSAGE_TYPES.INDEXING_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            codebaseIndexProgress: 100,
            connectionStatus: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
            isSyncing: false,
            canResume: false,
            isIndexingCompleted: true,
          });

          // Clear the 'Indexing completed successfully' message after 2 seconds
          clearStatusMessageAfterDelay(
            'codebase',
            'connectionStatus',
            'unknown'
          );
          break;
        case MESSAGE_TYPES.INDEXING_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            connectionStatus: 'error',
            statusMessage: `Indexing error: ${message.message}`,
            canResumeIndexing: true,
          });
          break;

        // Handle workspace path response
        case MESSAGE_TYPES.WORKSPACE_PATH:
          if (message.path) {
            batchUpdateConfig('codebase', {
              repoPath: message.path
            });
            console.log('Workspace path set to:', message.path);
          }
          break;

        // Indexing
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: message.progress,
            connectionStatus: 'unknown',
            isIndexing: message.progress < 100,
            canResumeIndexing: true,
            isSyncing: false,
            canResume: false,
          });
          break;
        case MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE:
          batchUpdateConfig('confluence', {
            confluenceIndexProgress: 100,
            connectionStatus: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
            isSyncing: false,
            canResume: false,
            isIndexingCompleted: true,
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

  const startConfluenceSync = () => {
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
  const startCodeBaseSync = () => {
    batchUpdateConfig('codebase', {
      isSyncing: true,
      codebaseIndexProgress: 0,
      statusMessage: 'Starting sync process...',
      connectionStatus: 'unknown',
      includePatterns: '**/*.{js,ts,jsx,tsx,py,java,c,cpp,h,hpp}',
      excludePatterns: '**/node_modules/**,**/dist/**,**/.git/**,**/.venv/**,**/venv/**,**/build/**,**/target/**,**/.*/**',
      maxFileSizeKb: 500,
    });

    vscode.postMessage({
      type: MESSAGE_TYPES.START_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  };

  const retry = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RETRY_OLLAMA_CHECK,
    });
  };

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

  const resumeCodebaseSync = () => {
    batchUpdateConfig('codebase', {
      isSyncing: true,
      statusMessage: 'Resuming codebase sync process...',
      connectionStatus: 'unknown',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  };

  const resumeCodebaseIndexing = () => {
    batchUpdateConfig('codebase', {
      isIndexing: true,
      statusMessage: 'Resuming codebase indexing process...',
      connectionStatus: 'unknown',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_INDEXING_CODEBASE,
      section: 'codebase',
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
        <div className='header-with-back'>
          <button
            className='back-button'
            onClick={onBack}
            aria-label='Go back'
          >
            ←
          </button>
          <h3>Settings</h3>
        </div>
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
                  Failed to download model &nbsp;
                  <button
                    onClick={() => retry()}
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
                  checked={config.confluence?.isConfluenceEnabled}
                  onChange={() =>
                    updateConfig(
                      'confluence',
                      'isConfluenceEnabled',
                      !config.confluence?.isConfluenceEnabled
                    )
                  }
                />
                <span className='slider round'></span>
              </label>
            </div>
            {config.confluence?.isConfluenceEnabled && (
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
                  ) : config.confluence.isIndexingCompleted ? (
                    <button
                      onClick={startConfluenceSync}
                      disabled={config.confluence.isIndexing}
                    >
                      Start Re-Sync
                    </button>
                  ) : (
                    <button
                      onClick={startConfluenceSync}
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
                  checked={config.codebase?.isCodebaseEnabled}
                  onChange={() =>
                    updateConfig(
                      'codebase',
                      'isCodebaseEnabled',
                      !config.codebase?.isCodebaseEnabled
                    )
                  }
                />
                <span className='slider round'></span>
              </label>
            </div>

            {config.codebase?.isCodebaseEnabled && (
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
                  <label htmlFor='codebase-include-patterns'>Include Patterns</label>
                  <input
                    id='codebase-include-patterns'
                    type='text'
                    value={config.codebase?.includePatterns}
                    onChange={(e) =>
                      handleInputChange('codebase', 'includePatterns', e.target.value)
                    }
                    placeholder='**/*.{js,ts,jsx,tsx,py,java,c,cpp,h,hpp}'
                  />
                  <small className='help-text'>Comma-separated glob patterns</small>
                </div>

                <div className='form-group'>
                  <label htmlFor='codebase-exclude-patterns'>Exclude Patterns</label>
                  <input
                    id='codebase-exclude-patterns'
                    type='text'
                    value={config.codebase?.excludePatterns}
                    onChange={(e) =>
                      handleInputChange('codebase', 'excludePatterns', e.target.value)
                    }
                    placeholder='**/node_modules/**,**/dist/**,**/.git/**'
                  />
                  <small className='help-text'>Comma-separated glob patterns</small>
                </div>

                <div className='form-group'>
                  <label htmlFor='codebase-max-file-size'>Max File Size (KB)</label>
                  <input
                    id='codebase-max-file-size'
                    type='number'
                    value={config.codebase?.maxFileSizeKb}
                    onChange={(e) =>
                      handleInputChange('codebase', 'maxFileSizeKb', e.target.value)
                    }
                    placeholder='500'
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
                      disabled={config.codebase.isIndexing}
                    >
                      Stop Sync
                    </button>
                  ) : config.codebase.canResume ? (
                    <button
                      onClick={resumeCodebaseSync}
                      className='resume-sync-button'
                      disabled={config.codebase.isIndexing}
                    >
                      Resume Sync
                    </button>
                  ) : config.codebase.isSyncCompleted ? (
                    <button
                      onClick={startCodeBaseSync}
                      disabled={config.codebase.isIndexing}
                    >
                      Start Re-Sync
                    </button>
                  ) : (
                    <button
                      onClick={startCodeBaseSync}
                      disabled={config.codebase.isIndexing}
                    >
                      Start Sync
                    </button>
                  )}
                </div>

                {config.codebase.connectionStatus !== 'unknown' && (
                  <div
                    className={`status-message ${config.codebase.connectionStatus}`}
                  >
                    {config.codebase.statusMessage}
                  </div>
                )}

                {config.codebase.isSyncing && (
                  <div className='sync-progress'>
                    <div className='progress-label'>
                      Syncing: {config.codebase.codebaseSyncProgress}%
                    </div>
                    <div className='progress-bar'>
                      <div
                        className='progress-fill'
                        style={{
                          width: `${config.codebase.codebaseSyncProgress}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                )}

                {config.codebase.isIndexing && (
                  <div className='sync-progress'>
                    <div className='progress-label'>
                      Indexing: {config.codebase.codebaseIndexProgress}%
                    </div>
                    <div className='progress-bar'>
                      <div
                        className='progress-fill'
                        style={{
                          width: `${config.codebase.codebaseIndexProgress}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                )}

                {/* Show resume indexing button if indexing was interrupted */}
                {!config.codebase.isSyncing &&
                 !config.codebase.isIndexing &&
                 config.codebase.canResumeIndexing && (
                  <div className='button-group'>
                    <button
                      onClick={resumeCodebaseIndexing}
                      className='resume-sync-button'
                    >
                      Resume Indexing
                    </button>
                  </div>
                )}
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
            resetSettingStore();
            resetModelStore();
            resetChatStore();
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
          Reset WorkspaceGPT
        </button>
      </div>
    </div>
  );
};

export default SettingsButton;
