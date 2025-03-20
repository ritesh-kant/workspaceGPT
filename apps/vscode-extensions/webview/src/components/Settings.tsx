import React, { useEffect } from 'react';
import { VSCodeAPI } from '../vscode';
import './Settings.css';
import { useSettingsStore } from '../store';

interface SettingsButtonProps {
  isVisible: boolean;
  onClose: () => void;
}

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onClose,
}) => {
  // Use settings store instead of local state
  const {
    config,
    isConfluenceEnabled,
    isCodebaseEnabled,
    isConfluenceSyncing,
    isCodebaseSyncing,
    confluenceSyncProgress,
    connectionStatus,
    statusMessage,
    setConfig,
    setIsConfluenceEnabled,
    setIsCodebaseEnabled,
    setIsConfluenceSyncing,
    setIsCodebaseSyncing,
    setConfluenceSyncProgress,
    setCodebaseSyncProgress,
    setConnectionStatus,
    setStatusMessage
  } = useSettingsStore();

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
        case 'confluenceConnectionStatus':
          setConnectionStatus(message.status ? 'success' : 'error');
          setStatusMessage(message.message || '');
          break;
        case 'syncProgress':
          setCodebaseSyncProgress(message.progress);
          if (message.source === 'confluence') {
            setConfluenceSyncProgress(message.progress);
            if (message.progress >= 100) {
              setIsConfluenceSyncing(false);
            }
          } else if (message.source === 'codebase') {
            setCodebaseSyncProgress(message.progress);
            if (message.progress >= 100) {
              setIsCodebaseSyncing(false);
            }
          }
          break;
        case 'syncComplete':
          if (message.source === 'confluence') {
            setIsConfluenceSyncing(false);
            setConfluenceSyncProgress(100);
          } else if (message.source === 'codebase') {
            setIsCodebaseSyncing(false);
            setCodebaseSyncProgress(100);
          }
          setStatusMessage('Sync completed successfully');
          break;
        case 'syncError':
          if (message.source === 'confluence') {
            setIsConfluenceSyncing(false);
          } else if (message.source === 'codebase') {
            setIsCodebaseSyncing(false);
          }
          setConnectionStatus('error');
          setStatusMessage(`Sync error: ${message.message}`);
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
        [field]: value
      }
    };
    setConfig(updatedConfig);
  };

  const saveConfig = () => {
    vscode.postMessage({
      type: 'saveSettingsButtonConfig',
      config,
    });
  };

  const checkConnection = () => {
    setConnectionStatus('unknown');
    setStatusMessage('Checking connection...');
    vscode.postMessage({
      type: 'checkConfluenceConnection',
      config,
    });
  };

  const startSync = () => {
    setIsConfluenceSyncing(true);
    setConfluenceSyncProgress(0);
    setStatusMessage('Starting sync process...');
    vscode.postMessage({
      type: 'startConfluenceSync',
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

      {
        <>
          <div className='settings-section'>
            <div className='section-header'>
              <h3>Confluence Integration</h3>
              <label className='toggle-switch'>
                <input
                  type='checkbox'
                  checked={isConfluenceEnabled}
                  onChange={() => setIsConfluenceEnabled(!isConfluenceEnabled)}
                />
                <span className='slider round'></span>
              </label>
            </div>
            {isConfluenceEnabled && (
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
                    value={config.confluence?.userEmail}
                    onChange={(e) =>
                      handleInputChange('confluence', 'userEmail', e.target.value)
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
                      handleInputChange('confluence', 'apiToken', e.target.value)
                    }
                    placeholder='Your Atlassian API token'
                  />
                </div>

                <div className='button-group'>
                  <button onClick={saveConfig}>Save</button>
                  <button onClick={checkConnection}>Check Connection</button>
                  <button
                    onClick={startSync}
                    disabled={isConfluenceSyncing || connectionStatus !== 'success'}
                  >
                    Start Sync
                  </button>
                </div>

                {connectionStatus !== 'unknown' && (
                  <div className={`status-message ${connectionStatus}`}>
                    {statusMessage}
                  </div>
                )}

                {isConfluenceSyncing && (
                  <div className='sync-progress'>
                    <div className='progress-label'>
                      Syncing: {confluenceSyncProgress}%
                    </div>
                    <div className='progress-bar'>
                      <div
                        className='progress-fill'
                        style={{ width: `${confluenceSyncProgress}%` }}
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
                  checked={isCodebaseEnabled}
                  onChange={() => setIsCodebaseEnabled(!isCodebaseEnabled)}
                />
                <span className='slider round'></span>
              </label>
            </div>
            {isCodebaseEnabled && (
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
                      handleInputChange('codebase', 'scanFrequency', e.target.value)
                    }
                  >
                    <option value='hourly'>Hourly</option>
                    <option value='daily'>Daily</option>
                    <option value='weekly'>Weekly</option>
                  </select>
                </div>

                <div className='button-group'>
                  <button onClick={saveConfig}>Save</button>
                  <button onClick={startSync} disabled={isCodebaseSyncing}>
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
