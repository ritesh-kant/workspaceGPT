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
import StatusDot from './StatusDot';

const AdoSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const adoConfig = config.ado || ({} as AdoConfig);

  // Host messages for this section are handled app-wide in
  // store/settingsMessages.ts — this panel unmounts on every trip back to
  // chat, and sync/connect completions are sent exactly once.

  const [showOrgName, setShowOrgName] = useState(false);
  const [showMoreOptions, setShowMoreOptions] = useState(false);
  const [showPatForm, setShowPatForm] = useState(false);
  const [patInput, setPatInput] = useState('');

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

  // Fetch organizations for anyone already authenticated but without a org
  // picked yet — covers both a fresh connect (belt-and-suspenders alongside
  // the host's own post-connect fetch) and a session that was authenticated
  // before this feature existed, where no connect event will ever fire again.
  useEffect(() => {
    if (
      adoConfig?.isAuthenticated &&
      !adoConfig?.orgName &&
      (!adoConfig?.availableOrganizations || adoConfig.availableOrganizations.length === 0)
    ) {
      vscode.postMessage({ type: MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS });
    }
  }, [adoConfig?.isAuthenticated, adoConfig?.orgName, adoConfig?.availableOrganizations]);

  // Fetch projects as soon as an org is known but no project is picked yet —
  // same fallback shape as the organizations effect above, so it self-heals
  // whether the org just got auto-selected, was picked from the dropdown, or
  // was typed manually into the fallback input.
  useEffect(() => {
    if (
      adoConfig?.isAuthenticated &&
      adoConfig?.orgName &&
      !adoConfig?.projectName &&
      (!adoConfig?.availableProjects || adoConfig.availableProjects.length === 0)
    ) {
      vscode.postMessage({ type: MESSAGE_TYPES.FETCH_ADO_PROJECTS, orgName: adoConfig.orgName });
    }
  }, [adoConfig?.isAuthenticated, adoConfig?.orgName, adoConfig?.projectName, adoConfig?.availableProjects]);

  const connectWithMicrosoft = () => {
    batchUpdateConfig('ado', {
      isConnecting: true,
      statusMessage: 'Waiting for Microsoft sign-in… (check your browser)',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.CONNECT_ADO_MSAL,
    });
  };

  const connectWithAzureCli = () => {
    batchUpdateConfig('ado', {
      isConnecting: true,
      statusMessage: 'Checking Azure CLI session…',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.CONNECT_ADO_AZURE_CLI,
    });
  };

  const submitPat = () => {
    const trimmed = patInput.trim();
    if (!trimmed) return;
    batchUpdateConfig('ado', {
      isConnecting: true,
      statusMessage: 'Verifying token…',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_ADO_PAT,
      pat: trimmed,
    });
    setPatInput('');
  };

  const refreshOrganizations = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS });
  };

  /** Org changed — the previously fetched project list belongs to the old org. */
  const selectOrg = (orgName: string) => {
    batchUpdateConfig('ado', {
      orgName,
      projectName: '',
      availableProjects: [],
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
          : (
              <>
                <StatusDot tone='ok' />
                {adoConfig.projectName} · {formatRelativeTime(adoConfig.lastSyncTime)}
              </>
            );

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
              Sign in with your Microsoft account to connect Azure DevOps —
              no app install or admin approval needed.
            </p>
            <button
              className='primary-button-full'
              onClick={connectWithMicrosoft}
              disabled={adoConfig?.isConnecting}
            >
              {adoConfig?.isConnecting ? 'Waiting for Microsoft sign-in…' : 'Sign in with Microsoft'}
            </button>

            {!showMoreOptions ? (
              <button
                type='button'
                className='secondary-button button-full mt-8'
                onClick={() => setShowMoreOptions(true)}
              >
                More sign-in options
              </button>
            ) : (
              <>
                <p className='description-text mt-8'>
                  Already signed in to the Azure CLI (<code>az login</code>)?
                </p>
                <button
                  className='secondary-button button-full'
                  onClick={connectWithAzureCli}
                  disabled={adoConfig?.isConnecting}
                >
                  {adoConfig?.isConnecting ? 'Connecting…' : 'Connect with Azure CLI'}
                </button>

                {!showPatForm ? (
                  <button
                    type='button'
                    className='secondary-button button-full mt-8'
                    onClick={() => setShowPatForm(true)}
                  >
                    Use a Personal Access Token instead
                  </button>
                ) : (
                  <div className="form-group mt-8">
                    <label>Personal Access Token</label>
                    <input
                      type="password"
                      value={patInput}
                      onChange={(e) => setPatInput(e.target.value)}
                      placeholder="Paste your Azure DevOps PAT"
                    />
                    <button
                      className='secondary-button button-full mt-8'
                      onClick={submitPat}
                      disabled={!patInput.trim() || adoConfig?.isConnecting}
                    >
                      {adoConfig?.isConnecting ? 'Verifying…' : 'Connect with token'}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Authenticated State */}
        {isAuthenticated && (
          <>
            {/* Disconnect is a quiet text link, not a red button: it sits in
                the one row that says everything is fine, and it is not a
                daily action. */}
            <div className="connected-banner">
              <span className="connected-label">
                <StatusDot tone='ok' />
                Connected to <strong>Azure DevOps</strong>
                {adoConfig.userDisplayName ? ` as ${adoConfig.userDisplayName}` : ''}
              </span>
              <button type='button' onClick={disconnect} className="disconnect-link">
                Disconnect
              </button>
            </div>

            <div className="form-group">
              <label>Organization</label>
              {adoConfig.availableOrganizations && adoConfig.availableOrganizations.length > 0 ? (
                <SearchableDropdown
                  value={adoConfig.orgName || ''}
                  options={adoConfig.availableOrganizations.map((o) => ({
                    value: o.accountName,
                    label: o.accountName,
                  }))}
                  onChange={selectOrg}
                  placeholder='-- Select an organization --'
                  searchPlaceholder='Search organizations...'
                  emptyLabel='No organizations found...'
                />
              ) : (
                <>
                  <div className="password-input-container">
                    <input
                      type={showOrgName ? "text" : "password"}
                      value={adoConfig.orgName || ''}
                      onChange={(e) => selectOrg(e.target.value)}
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
                  <button
                    type='button'
                    className='link-like'
                    onClick={refreshOrganizations}
                  >
                    Fetch my organizations
                  </button>
                </>
              )}
            </div>
            <div className="form-group">
              <label>Project</label>
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
                <>
                  <input
                    type="text"
                    value={adoConfig.projectName || ''}
                    onChange={(e) => handleInputChange('ado', 'projectName', e.target.value)}
                    placeholder="Ex: MyProject"
                  />
                  <button
                    type='button'
                    className='link-like'
                    onClick={fetchProjects}
                    disabled={!adoConfig.orgName || adoConfig.isConnecting}
                  >
                    Refresh projects
                  </button>
                </>
              )}
            </div>

            <div className="form-group">
              <label>Sync tickets from</label>
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
