import React, { useEffect } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { handleJiraActions, handleInputChange } from './utils';
import { JiraConfig } from '../../types';
import { MESSAGE_TYPES } from '../../constants';
import SearchableDropdown from './SearchableDropdown';
import SectionShell from './SectionShell';
import SyncControls, { SyncStatusMessage } from './SyncControls';
import StatusDot from './StatusDot';

/**
 * OAuth 3LO connect (replaced the original API-token form post-P9) — a
 * near-clone of ConfluenceSettings.tsx's "Connect with Atlassian" flow,
 * otherwise the same shape as AdoSettings.tsx: project picker, lookback,
 * sync controls (§5 P5).
 */
const JiraSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const jiraConfig = config.jira || ({} as JiraConfig);

  // Host messages for this section are handled app-wide in
  // store/settingsMessages.ts — this panel unmounts on every trip back to
  // chat, and connect/disconnect completions are sent exactly once.

  // Fetch projects as soon as connected but none picked yet — same
  // self-healing fallback AdoSettings uses, covering both a fresh connect and
  // a session authenticated before a project was ever chosen.
  useEffect(() => {
    if (
      jiraConfig?.isAuthenticated &&
      !jiraConfig?.projectKey &&
      (!jiraConfig?.availableProjects || jiraConfig.availableProjects.length === 0)
    ) {
      vscode.postMessage({ type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS });
    }
  }, [jiraConfig?.isAuthenticated, jiraConfig?.projectKey, jiraConfig?.availableProjects]);

  const startOAuth = () => {
    batchUpdateConfig('jira', {
      isConnecting: true,
      statusMessage: 'Opening browser for authentication...',
      messageType: 'success',
    });
    handleJiraActions.startOAuth(vscode);
  };

  const cancelOAuth = () => {
    handleJiraActions.cancelOAuth(vscode);
    // State will be updated via the response from extension
  };

  const fetchProjects = () => {
    batchUpdateConfig('jira', {
      isConnecting: true,
      statusMessage: 'Fetching available projects...',
      messageType: 'success',
    });
    vscode.postMessage({ type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS });
  };

  const selectProject = (key: string) => {
    const project = jiraConfig.availableProjects?.find((p) => p.key === key);
    batchUpdateConfig('jira', { projectKey: key, projectName: project?.name || key });
  };

  const disconnect = () => {
    handleJiraActions.disconnect(vscode);
  };

  const isAuthenticated = jiraConfig?.isAuthenticated;
  const hasProjectSelected = !!jiraConfig?.projectKey;

  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateConfig('jira', 'isJiraEnabled', e.target.checked);
  };

  const isEnabled = !!jiraConfig?.isJiraEnabled;
  const isBusy = !!jiraConfig?.isSyncing || !!jiraConfig?.isIndexing;
  const hasError = jiraConfig?.messageType === 'error' && !!jiraConfig?.statusMessage;

  const summary = !isEnabled
    ? 'Off'
    : !isAuthenticated
      ? 'Not connected'
      : !hasProjectSelected
        ? 'Connected · no project selected'
        : isBusy
          ? jiraConfig.isSyncing
            ? `Syncing… ${jiraConfig.jiraSyncProgress || 0}%`
            : `Indexing… ${jiraConfig.jiraIndexProgress || 0}%`
          : (
              <>
                <StatusDot tone='ok' />
                {jiraConfig.projectName}
              </>
            );

  return (
    <SectionShell
      storageKey='jira'
      title='Jira'
      summary={summary}
      needsAttention={isEnabled && (!isAuthenticated || !hasProjectSelected || hasError)}
      headerControl={
        <label className='toggle-switch'>
          <input type='checkbox' checked={isEnabled} onChange={handleToggleChange} />
          <span className='slider round'></span>
        </label>
      }
    >
      {jiraConfig?.isJiraEnabled && (
        <div className='settings-form'>
          {/* Not Authenticated State */}
          {!isAuthenticated && (
            <div className='oauth-connect'>
              <p className='description-text'>
                Connect your Atlassian account to sync Jira issues.
              </p>
              <button
                onClick={startOAuth}
                disabled={jiraConfig?.isConnecting}
                className='primary-button-full'
              >
                {jiraConfig?.isConnecting ? 'Connecting…' : 'Connect to Jira'}
              </button>
              {jiraConfig?.isConnecting && (
                <button onClick={cancelOAuth} className='secondary-button button-full mt-8'>
                  Cancel
                </button>
              )}
            </div>
          )}

          {/* Authenticated State */}
          {isAuthenticated && (
            <>
              <div className='connected-banner'>
                <span className='connected-label'>
                  <StatusDot tone='ok' />
                  Connected to <strong>Jira</strong>
                  {jiraConfig.displayName ? ` as ${jiraConfig.displayName}` : ''}
                </span>
                <button type='button' onClick={disconnect} className='disconnect-link'>
                  Disconnect
                </button>
              </div>

              <div className='form-group'>
                <label>Project</label>
                {jiraConfig.availableProjects && jiraConfig.availableProjects.length > 0 ? (
                  <SearchableDropdown
                    value={jiraConfig.projectKey || ''}
                    options={jiraConfig.availableProjects.map((p) => ({
                      value: p.key,
                      label: `${p.name} (${p.key})`,
                    }))}
                    onChange={selectProject}
                    placeholder='-- Select a project --'
                    searchPlaceholder='Search projects...'
                    emptyLabel='No projects found...'
                  />
                ) : (
                  <>
                    <input
                      type='text'
                      value={jiraConfig.projectKey || ''}
                      onChange={(e) => handleInputChange('jira', 'projectKey', e.target.value.toUpperCase())}
                      placeholder='Ex: PROJ'
                    />
                    <button
                      type='button'
                      className='link-like'
                      onClick={fetchProjects}
                      disabled={jiraConfig.isConnecting}
                    >
                      Refresh projects
                    </button>
                  </>
                )}
              </div>

              <div className='form-group'>
                <label>Sync tickets from</label>
                <select
                  value={jiraConfig.lookbackMonths ?? 24}
                  onChange={(e) => handleInputChange('jira', 'lookbackMonths', Number(e.target.value))}
                  className='settings-select'
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

              {hasProjectSelected && <SyncControls section='jira' />}
            </>
          )}

          <SyncStatusMessage section='jira' />
        </div>
      )}
    </SectionShell>
  );
};

export default JiraSettings;
