import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import {
  formatRelativeTime,
  handleAdoActions,
  handleInputChange,
} from './utils';
import { AdoConfig } from '../../types';
import { MESSAGE_TYPES } from '../../constants';
import SearchableDropdown from './SearchableDropdown';
import SectionShell from './SectionShell';
import SyncControls, { SyncStatusMessage } from './SyncControls';

const AdoSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const adoConfig = config.ado || ({} as AdoConfig);

  // Host messages for this section are handled app-wide in
  // store/settingsMessages.ts — this panel unmounts on every trip back to
  // chat, and sync/PAT completions are sent exactly once.

  const [patInput, setPatInput] = useState('');
  const [showOrgName, setShowOrgName] = useState(false);

  // Auto-detect identity as soon as all required details are available
  useEffect(() => {
    if (
      adoConfig?.isAuthenticated &&
      adoConfig?.orgName &&
      adoConfig?.projectName &&
      !adoConfig?.userDisplayName
    ) {
      vscode.postMessage({ type: MESSAGE_TYPES.FETCH_ADO_USER_IDENTITY });
    }
  }, [adoConfig?.isAuthenticated, adoConfig?.orgName, adoConfig?.projectName]);

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

  const isAuthenticated = adoConfig?.isAuthenticated;
  const hasProjectSelected = !!adoConfig?.orgName && !!adoConfig?.projectName;

  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateConfig('ado', 'isAdoEnabled', e.target.checked);
  };

  const isEnabled = !!adoConfig?.isAdoEnabled;
  const isBusy = !!adoConfig?.isSyncing || !!adoConfig?.isIndexing;
  const hasError = adoConfig?.messageType === 'error' && !!adoConfig?.statusMessage;

  const summary = !isEnabled
    ? 'Off'
    : !isAuthenticated
      ? 'Not connected'
      : !hasProjectSelected
        ? 'Connected · no project selected'
        : isBusy
          ? adoConfig.isSyncing
            ? `Syncing… ${adoConfig.adoSyncProgress || 0}%`
            : `Indexing… ${adoConfig.adoIndexProgress || 0}%`
          : `✅ ${adoConfig.projectName} · ${formatRelativeTime(adoConfig.lastSyncTime)}`;

  return (
    <SectionShell
      storageKey='ado'
      title='Azure DevOps'
      summary={summary}
      needsAttention={isEnabled && (!isAuthenticated || !hasProjectSelected || hasError)}
      headerControl={
        <label className='toggle-switch'>
          <input
            type='checkbox'
            checked={isEnabled}
            onChange={handleToggleChange}
          />
          <span className='slider round'></span>
        </label>
      }
    >
      {adoConfig?.isAdoEnabled && (
      <div className="settings-form">

        {/* Not Authenticated State */}
        {!isAuthenticated && (
          <div className="pat-connect">
            <p className='description-text'>
              Enter your Azure DevOps Personal Access Token (PAT).
            </p>
            <div className='pat-scopes'>
              <span>Required PAT scopes:</span>
              <span>✅ <strong>Work Items</strong> — Read <em>(tickets, queries, sprint detection)</em></span>
              <span>✅ <strong>Project and Team</strong> — Read <em>(project listing)</em></span>
            </div>
            <div className="form-group">
              <input
                type="password"
                value={patInput}
                onChange={(e) => setPatInput(e.target.value)}
                placeholder="Paste your PAT here..."
                className='pat-input'
              />
            </div>
            <button
              className='primary-button-full'
              onClick={submitPat}
              disabled={!patInput.trim() || adoConfig?.isConnecting}
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
                <div className="password-input-container">
                  <input
                    type={showOrgName ? "text" : "password"}
                    value={adoConfig.orgName || ''}
                    onChange={(e) => handleInputChange('ado', 'orgName', e.target.value)}
                    placeholder="Ex: MyOrganization"
                  />
                  <button
                    type="button"
                    className="password-toggle-btn"
                    onClick={() => setShowOrgName(!showOrgName)}
                    title={showOrgName ? "Hide organization name" : "Show organization name"}
                  >
                    {showOrgName ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
                    )}
                  </button>
                </div>
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
                /* Same control Confluence uses for spaces — org project lists
                   run long enough that a native select is hard to navigate. */
                <SearchableDropdown
                  value={adoConfig.projectName || ''}
                  options={adoConfig.availableProjects.map((p) => ({
                    value: p.name,
                    label: p.name,
                  }))}
                  onChange={(name) => handleInputChange('ado', 'projectName', name)}
                  placeholder='-- Select a project --'
                  searchPlaceholder='Search projects...'
                  emptyLabel='No projects found...'
                />
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

            {/* Action Buttons + sync status — shared with Confluence */}
            {hasProjectSelected && <SyncControls section='ado' />}
          </>
        )}

        <SyncStatusMessage section='ado' />
      </div>
      )}
    </SectionShell>
  );
};

export default AdoSettings;
