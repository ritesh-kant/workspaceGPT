import React from 'react';
import { useEffect } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { clearStatusMessageAfterDelay, handleCodebaseActions, handleInputChange } from './utils';
import { CodebaseConfig } from '../../types';
import { MESSAGE_TYPES } from '../../constants';

const CodebaseSettings: React.FC = () => {
  const {
    config,
    batchUpdateConfig,
    updateConfig, // Added updateConfig to handle toggle change
  } = useSettingsStore();

  const vscode = VSCodeAPI();
  const codebaseConfig = config.codebase as CodebaseConfig;

  useEffect(() => {

    // Listen for codebase configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case MESSAGE_TYPES.SYNC_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseSyncProgress: message.progress,
            messageType: 'success',
            isSyncing: message.progress < 100,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            codebaseSyncProgress: 100,
            messageType: 'success',
            statusMessage: 'Sync completed successfully',
            canResume: false,
            isSyncCompleted: true,
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'statusMessage',
          );
          break;

        case MESSAGE_TYPES.SYNC_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: `Sync error: ${message.message}`,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.CODEBASE_CONNECTION_STATUS:
          batchUpdateConfig('codebase', {
            messageType: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'statusMessage',
          );
          break;

        // Codebase Indexing
        case MESSAGE_TYPES.INDEXING_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseIndexProgress: message.progress,
            messageType: 'success',
            isIndexing: true,
            canResumeIndexing: true,
            isSyncing: false,
            canResume: false,
          });
          break;

        case MESSAGE_TYPES.INDEXING_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            codebaseIndexProgress: 100,
            messageType: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
            isSyncing: false,
            canResume: false,
            isIndexingCompleted: true,
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'statusMessage',
          );
          break;

        case MESSAGE_TYPES.INDEXING_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            isIndexing: false,
            messageType: 'error',
            statusMessage: `Indexing error: ${message.message}`,
            canResumeIndexing: true,
          });
          break;

        // Handle workspace path response
        case MESSAGE_TYPES.WORKSPACE_PATH:
          if (message.path) {
            batchUpdateConfig('codebase', {
              repoPath: message.path,
            });
          }
          break;


      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateConfig('codebase', 'isCodebaseEnabled', e.target.checked);
  };

  const startSync = () => {
    batchUpdateConfig('codebase', {
      isSyncing: true,
      codebaseIndexProgress: 0,
      statusMessage: 'Starting sync process...',
      messageType: 'success',
      includePatterns: '**/*.{js,ts,jsx,tsx,py,java,c,cpp,h,hpp}',
      excludePatterns:
        '**/node_modules/**,**/dist/**,**/.git/**,**/.venv/**,**/venv/**,**/build/**,**/target/**,**/.*/**',
      maxFileSizeKb: 500,
    });
    handleCodebaseActions.startSync(vscode, config);
  };

  const resumeSync = () => {
    batchUpdateConfig('codebase', {
      isSyncing: true,
      statusMessage: 'Resuming codebase sync process...',
      messageType: 'success',
    });
    handleCodebaseActions.resumeSync(vscode, config);
  };

  const resumeIndexing = () => {
    batchUpdateConfig('codebase', {
      isIndexing: true,
      statusMessage: 'Resuming codebase indexing process...',
      messageType: 'success',
    });
    handleCodebaseActions.resumeIndexing(vscode, config);
  };

  const stopSync = () => {
    batchUpdateConfig('codebase', {
      isSyncing: false,
      isIndexing: false,
      statusMessage: 'Stopping process...',
    });
    handleCodebaseActions.stopSync(vscode, config);
  };

  // const handleReset = () => {
  //   resetStore();
  //   handleCodebaseActions.stopSync(vscode, config);
  // };

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>Codebase Integration</h3>
        <label className='toggle-switch'>
          <input
            type='checkbox'
            checked={codebaseConfig?.isCodebaseEnabled}
            onChange={handleToggleChange}
            disabled
          />
          <span className='slider round'></span>
        </label>
      </div>

      {codebaseConfig?.isCodebaseEnabled && (
        <div className='settings-form'>
          <div className='form-group'>
            <label htmlFor='codebase-repo-path'>Repository Path</label>
            <input
              id='codebase-repo-path'
              type='text'
              value={codebaseConfig?.repoPath}
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
              value={codebaseConfig?.includePatterns}
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
              value={codebaseConfig?.excludePatterns}
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
              value={codebaseConfig?.maxFileSizeKb}
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
              value={codebaseConfig?.scanFrequency}
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
            {codebaseConfig.isSyncing ? (
              <button
                onClick={stopSync}
                className='stop-sync-button'
                disabled={codebaseConfig.isIndexing}
              >
                Stop Sync
              </button>
            ) : codebaseConfig.canResume ? (
              <button
                onClick={resumeSync}
                className='resume-sync-button'
                disabled={codebaseConfig.isIndexing}
              >
                Resume Sync
              </button>
            ) : codebaseConfig.isSyncCompleted ? (
              <button
                onClick={startSync}
                disabled={codebaseConfig.isIndexing}
              >
                Start Re-Sync
              </button>
            ) : (
              <button
                onClick={startSync}
                disabled={codebaseConfig.isIndexing}
              >
                Start Sync
              </button>
            )}
          </div>

          {codebaseConfig.messageType && (
            <div
              className={`status-message ${codebaseConfig.messageType}`}
            >
              {codebaseConfig.statusMessage}
            </div>
          )}

          {codebaseConfig.isSyncing && (
            <div className='sync-progress'>
              <div className='progress-label'>
                Syncing: {codebaseConfig.codebaseSyncProgress}%
              </div>
              <div className='progress-bar'>
                <div
                  className='progress-fill'
                  style={{
                    width: `${codebaseConfig.codebaseSyncProgress}%`,
                  }}
                ></div>
              </div>
            </div>
          )}

          {codebaseConfig.isIndexing && (
            <div className='sync-progress'>
              <div className='progress-label'>
                Indexing: {codebaseConfig.codebaseIndexProgress}%
              </div>
              <div className='progress-bar'>
                <div
                  className='progress-fill'
                  style={{
                    width: `${codebaseConfig.codebaseIndexProgress}%`,
                  }}
                ></div>
              </div>
            </div>
          )}

          {/* Show resume indexing button if indexing was interrupted */}
          {!codebaseConfig.isSyncing &&
            !codebaseConfig.isIndexing &&
            codebaseConfig.canResumeIndexing && (
              <div className='button-group'>
                <button
                  onClick={resumeIndexing}
                  className='resume-sync-button'
                >
                  Resume Indexing
                </button>
              </div>
            )}
        </div>
      )}
    </div>
  );
};

export default CodebaseSettings;