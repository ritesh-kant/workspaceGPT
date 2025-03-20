import React, { useState, useEffect } from 'react';
import { VSCodeAPI } from '../vscode';
import './Settings.css';

interface SettingsButtonConfig {
  baseUrl: string;
  spaceKey: string;
  userEmail: string;
  apiToken: string;
  repoPath: string;
  scanFrequency: string;
}

interface SettingsButtonProps {
  isVisible: boolean;
  onClose: () => void;
}

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onClose,
}) => {
  const [config, setConfig] = useState<SettingsButtonConfig>({
    baseUrl: '',
    spaceKey: '',
    userEmail: '',
    apiToken: '',
    repoPath: '',
    scanFrequency: 'daily',
  });
  const [isConfluenceEnabled, setIsConfluenceEnabled] = useState(false);
  const [isCodebaseEnabled, setIsCodebaseEnabled] = useState(false);
  const [isSyncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<
    'unknown' | 'success' | 'error'
  >('unknown');
  const [statusMessage, setStatusMessage] = useState('');

  const vscode = VSCodeAPI();

  useEffect(() => {
    // Request current configuration when component mounts
    vscode.postMessage({ type: 'getSettingsButtonConfig' });

    // Listen for configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case 'SettingsButtonConfig':
          setConfig(message.config);
          break;
        case 'confluenceConnectionStatus':
          setConnectionStatus(message.status ? 'success' : 'error');
          setStatusMessage(message.message || '');
          break;
        case 'syncProgress':
          setSyncProgress(message.progress);
          if (message.progress >= 100) {
            setSyncing(false);
          }
          break;
        case 'syncComplete':
          setSyncing(false);
          setSyncProgress(100);
          setStatusMessage('Sync completed successfully');
          break;
        case 'syncError':
          setSyncing(false);
          setConnectionStatus('error');
          setStatusMessage(`Sync error: ${message.message}`);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleInputChange = (
    field: keyof SettingsButtonConfig,
    value: string
  ) => {
    setConfig({
      ...config,
      [field]: value,
    });
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
    setSyncing(true);
    setSyncProgress(0);
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
                    value={config.baseUrl}
                    onChange={(e) =>
                      handleInputChange('baseUrl', e.target.value)
                    }
                    placeholder='https://your-domain.atlassian.net'
                  />
                </div>

                <div className='form-group'>
                  <label htmlFor='confluence-space-key'>Space Key</label>
                  <input
                    id='confluence-space-key'
                    type='text'
                    value={config.spaceKey}
                    onChange={(e) =>
                      handleInputChange('spaceKey', e.target.value)
                    }
                    placeholder='SPACE'
                  />
                </div>

                <div className='form-group'>
                  <label htmlFor='confluence-user-email'>User Email</label>
                  <input
                    id='confluence-user-email'
                    type='email'
                    value={config.userEmail}
                    onChange={(e) =>
                      handleInputChange('userEmail', e.target.value)
                    }
                    placeholder='your.email@example.com'
                  />
                </div>

                <div className='form-group'>
                  <label htmlFor='confluence-api-token'>API Token</label>
                  <input
                    id='confluence-api-token'
                    type='password'
                    value={config.apiToken}
                    onChange={(e) =>
                      handleInputChange('apiToken', e.target.value)
                    }
                    placeholder='Your Atlassian API token'
                  />
                </div>

                <div className='button-group'>
                  <button onClick={saveConfig}>Save</button>
                  <button onClick={checkConnection}>Check Connection</button>
                  <button
                    onClick={startSync}
                    disabled={isSyncing || connectionStatus !== 'success'}
                  >
                    Start Sync
                  </button>
                </div>

                {connectionStatus !== 'unknown' && (
                  <div className={`status-message ${connectionStatus}`}>
                    {statusMessage}
                  </div>
                )}

                {isSyncing && (
                  <div className='sync-progress'>
                    <div className='progress-label'>
                      Syncing: {syncProgress}%
                    </div>
                    <div className='progress-bar'>
                      <div
                        className='progress-fill'
                        style={{ width: `${syncProgress}%` }}
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
                    value={config.repoPath}
                    onChange={(e) =>
                      handleInputChange('repoPath', e.target.value)
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
                    value={config.scanFrequency}
                    onChange={(e) =>
                      handleInputChange('scanFrequency', e.target.value)
                    }
                  >
                    <option value='hourly'>Hourly</option>
                    <option value='daily'>Daily</option>
                    <option value='weekly'>Weekly</option>
                  </select>
                </div>

                <div className='button-group'>
                  <button onClick={saveConfig}>Save</button>
                  <button onClick={startSync} disabled={isSyncing}>
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
