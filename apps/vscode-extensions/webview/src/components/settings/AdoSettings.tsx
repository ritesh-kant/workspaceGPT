import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import {
  clearStatusMessageAfterDelay,
  handleAdoActions,
  handleInputChange,
} from './utils';
import { AdoConfig } from '../../types';
import { MESSAGE_TYPES, SYNC_INTERVAL_MS } from '../../constants';

const AdoSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const adoConfig = config.ado || ({} as AdoConfig);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case MESSAGE_TYPES.ADO_PAT_SUCCESS:
          batchUpdateConfig('ado', {
            isAuthenticated: true,
            isConnecting: false,
            messageType: 'success',
            statusMessage: 'Saved Personal Access Token',
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        case MESSAGE_TYPES.ADO_PAT_ERROR:
          batchUpdateConfig('ado', {
            isConnecting: false,
            messageType: 'error',
            statusMessage: message.message || 'PAT Save failed',
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        case MESSAGE_TYPES.FETCH_ADO_PROJECTS_SUCCESS:
          batchUpdateConfig('ado', {
            isConnecting: false,
            messageType: 'success',
            statusMessage: 'Projects loaded successfully',
            availableProjects: message.projects || [],
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        case MESSAGE_TYPES.FETCH_ADO_PROJECTS_ERROR:
          batchUpdateConfig('ado', {
            isConnecting: false,
            messageType: 'error',
            statusMessage: message.message || 'Failed to load projects',
            availableProjects: [],
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        case MESSAGE_TYPES.DISCONNECT_ADO:
          batchUpdateConfig('ado', {
            isAuthenticated: false,
            orgName: '',
            projectName: '',
            isSyncing: false,
            isIndexing: false,
            canResume: false,
            canResumeIndexing: false,
            isSyncCompleted: false,
            isIndexingCompleted: false,
            adoSyncProgress: 0,
            adoIndexProgress: 0,
            lastSyncTime: '',
            messageType: 'success',
            statusMessage: 'Disconnected from Azure DevOps',
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        // Connection check
        case MESSAGE_TYPES.ADO_CONNECTION_STATUS:
          batchUpdateConfig('ado', {
            messageType: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        // Sync
        case MESSAGE_TYPES.SYNC_ADO_IN_PROGRESS:
          batchUpdateConfig('ado', {
            adoSyncProgress: message.progress,
            messageType: 'success',
            isSyncing: message.progress < 100,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_ADO_COMPLETE:
          batchUpdateConfig('ado', {
            messageType: 'success',
            statusMessage: 'Sync completed successfully',
            adoSyncProgress: 100,
            isSyncing: false,
            canResume: false,
            isSyncCompleted: true,
            lastSyncTime: message.lastSyncTime || new Date().toISOString(),
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        case MESSAGE_TYPES.SYNC_ADO_ERROR:
          batchUpdateConfig('ado', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: 'Sync error: Please verify your connection and try again.',
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_ADO_STOP:
          batchUpdateConfig('ado', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: 'Sync stopped',
            canResume: true,
          });
          break;

        // Indexing
        case MESSAGE_TYPES.INDEXING_ADO_IN_PROGRESS:
          batchUpdateConfig('ado', {
            adoIndexProgress: message.progress,
            messageType: 'success',
            isIndexing: true,
            canResumeIndexing: true,
            isSyncing: false,
            canResume: false,
          });
          break;

        case MESSAGE_TYPES.INDEXING_ADO_COMPLETE:
          batchUpdateConfig('ado', {
            adoIndexProgress: 100,
            messageType: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
            isSyncing: false,
            canResume: false,
            isIndexingCompleted: true,
          });
          clearStatusMessageAfterDelay('ado', 'statusMessage');
          break;

        case MESSAGE_TYPES.INDEXING_ADO_ERROR:
          batchUpdateConfig('ado', {
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

  const [patInput, setPatInput] = useState('');

  const submitPat = () => {
    batchUpdateConfig('ado', {
      isConnecting: true,
      statusMessage: 'Saving Personal Access Token...',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_ADO_PAT,
      pat: patInput
    });
  };

  const fetchProjects = () => {
    batchUpdateConfig('ado', {
      isConnecting: true,
      statusMessage: 'Fetching available projects...',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.FETCH_ADO_PROJECTS,
      orgName: adoConfig.orgName
    });
  };

  const disconnect = () => {
    handleAdoActions.disconnect(vscode);
  };

  const checkConnection = () => {
    batchUpdateConfig('ado', {
      messageType: 'success',
      statusMessage: 'Checking connection...',
    });
    handleAdoActions.checkConnection(vscode, config);
  };

  const startSync = (forceFull: boolean = false) => {
    batchUpdateConfig('ado', {
      isSyncing: true,
      adoSyncProgress: 0,
      statusMessage: forceFull ? 'Starting full sync process...' : 'Starting sync process...',
      messageType: 'success',
    });
    handleAdoActions.startSync(vscode, config, forceFull);
    clearStatusMessageAfterDelay('ado', 'statusMessage');
  };

  const resumeSync = () => {
    batchUpdateConfig('ado', {
      isSyncing: true,
      statusMessage: 'Resuming sync process...',
      messageType: 'success',
    });
    handleAdoActions.resumeSync(vscode, config);
    clearStatusMessageAfterDelay('ado', 'statusMessage');
  };

  const stopSync = () => {
    batchUpdateConfig('ado', {
      isSyncing: false,
      isIndexing: false,
      statusMessage: 'Stopping process...',
      messageType: 'error',
    });
    handleAdoActions.stopSync(vscode, config);
    clearStatusMessageAfterDelay('ado', 'statusMessage');
  };

  const isAuthenticated = adoConfig?.isAuthenticated;
  const hasProjectSelected = !!adoConfig?.orgName && !!adoConfig?.projectName;

  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateConfig('ado', 'isAdoEnabled', e.target.checked);
  };

  return (
    <div className="settings-section">
      <div className="section-header">
        <h3>Azure DevOps Integration</h3>
        <label className='toggle-switch'>
          <input
            type='checkbox'
            checked={!!adoConfig?.isAdoEnabled}
            onChange={handleToggleChange}
          />
          <span className='slider round'></span>
        </label>
      </div>
      {adoConfig?.isAdoEnabled && (
      <div className="settings-form">

        {/* Not Authenticated State */}
        {!isAuthenticated && (
          <div className="pat-connect">
            <p style={{ color: '#a0a0a0', margin: '0 0 8px 0', fontSize: '0.9em' }}>
              Enter your Azure DevOps Personal Access Token (PAT).
            </p>
            <div className="form-group">
              <input
                type="password"
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
                placeholder="Paste your PAT here..."
                style={{ width: '100%', padding: '8px', marginBottom: '8px', boxSizing: 'border-box' }}
              />
            </div>
            <button
              onClick={submitPat}
              disabled={!patInput.trim() || adoConfig?.isConnecting}
              style={{
                width: '100%',
                padding: '10px 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {adoConfig?.isConnecting ? (
                <>⏳ Connecting...</>
              ) : (
                <>🔗 Connect to Azure DevOps</>
              )}
            </button>
          </div>
        )}

        {/* Authenticated State */}
        {isAuthenticated && (
          <>
            <div className="connected-banner">
              <span className="connected-label">
                ✅ Connected to <strong>Azure DevOps</strong>
              </span>
              <button
                onClick={disconnect}
                className="disconnect-button"
              >
                Disconnect
              </button>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>Organization Name</label>
                <input
                  type="text"
                  value={adoConfig.orgName || ''}
                  onChange={(e) => handleInputChange('ado', 'orgName', e.target.value)}
                  placeholder="Ex: MyOrganization"
                />
              </div>
              <button 
                onClick={fetchProjects} 
                disabled={!adoConfig.orgName || adoConfig.isConnecting}
              >
                Fetch Projects
              </button>
            </div>
            <div className="form-group">
              <label>Project Name</label>
              {adoConfig.availableProjects && adoConfig.availableProjects.length > 0 ? (
                <select
                  value={adoConfig.projectName || ''}
                  onChange={(e) => handleInputChange('ado', 'projectName', e.target.value)}
                  className="settings-select"
                >
                  <option value="">Select a project...</option>
                  {adoConfig.availableProjects.map((p) => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={adoConfig.projectName || ''}
                  onChange={(e) => handleInputChange('ado', 'projectName', e.target.value)}
                  placeholder="Ex: MyProject"
                />
              )}
            </div>

            <div className="form-group">
              <label>Lookback Period</label>
              <select
                value={adoConfig.lookbackMonths ?? 24}
                onChange={(e) => handleInputChange('ado', 'lookbackMonths', Number(e.target.value))}
                className="settings-select"
              >
                <option value={1}>Last 1 month</option>
                <option value={3}>Last 3 months</option>
                <option value={6}>Last 6 months</option>
                <option value={12}>Last 1 year</option>
                <option value={18}>Last 18 months</option>
                <option value={24}>Last 2 years</option>
                <option value={36}>Last 3 years</option>
              </select>
            </div>

            {hasProjectSelected && (
              <>
                <div className="button-group">
                  <button onClick={checkConnection}>Check Connection</button>
                  {(adoConfig.isSyncing || adoConfig.isIndexing) ? (
                    <button onClick={stopSync} className="stop-sync-button">
                      {adoConfig.isIndexing ? 'Stop Indexing' : 'Stop Sync'}
                    </button>
                  ) : adoConfig.canResume ? (
                    <button onClick={resumeSync} className="resume-sync-button">
                      Resume Sync
                    </button>
                  ) : (
                    <>
                      <button onClick={() => startSync(false)}>
                        {adoConfig.lastSyncTime ? 'Sync Recent Changes' : 'Start Sync'}
                      </button>
                      {adoConfig.lastSyncTime && (
                        <button
                          onClick={() => startSync(true)}
                          className="secondary-button"
                        >
                          Force Full Re-Sync
                        </button>
                      )}
                    </>
                  )}
                </div>

                <div className="sync-status-container" style={{ marginTop: '12px' }}>
                  {(adoConfig.isSyncing || adoConfig.isIndexing) ? (
                    <div className="active-sync-indicator" style={{ color: '#4ecca3', fontSize: '0.95em', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span className="spinner">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      </span>
                      {adoConfig.isSyncing
                        ? `Syncing... (${adoConfig.adoSyncProgress || 0}%)`
                        : `Indexing... (${adoConfig.adoIndexProgress || 0}%)`}
                    </div>
                  ) : adoConfig.lastSyncTime ? (
                    <div className="last-sync-time">
                      Last Sync: {new Date(adoConfig.lastSyncTime).toLocaleString()}
                      <span className="next-sync-time">
                        (Next auto-sync at ~{new Date(new Date(adoConfig.lastSyncTime).getTime() + SYNC_INTERVAL_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
                      </span>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </>
        )}

        {adoConfig?.statusMessage && (
          <div className={`status-message ${adoConfig.messageType === 'success' ? 'success' : 'error'}`}>
            {adoConfig.statusMessage}
          </div>
        )}
      </div>
      )}
    </div>
  );
};

export default AdoSettings;
