import React, { useEffect, useState } from 'react';
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
 * One auth mode (API token — OAuth is deferred, JIRA-INTEGRATION-DESIGN.md
 * §5 P2), otherwise the same shape as AdoSettings.tsx: connect, project
 * picker, lookback, sync controls (§5 P5).
 */
const JiraSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const jiraConfig = config.jira || ({} as JiraConfig);

  // Host messages for this section are handled app-wide in
  // store/settingsMessages.ts — this panel unmounts on every trip back to
  // chat, and connect/disconnect completions are sent exactly once.

  const [showEmail, setShowEmail] = useState(false);
  const [siteInput, setSiteInput] = useState('');
  const [emailInput, setEmailInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');

  // Fetch projects as soon as connected but none picked yet — same
  // self-healing fallback AdoSettings uses, covering both a fresh connect and
  // a session authenticated before a project was ever chosen.
  useEffect(() => {
    if (
      jiraConfig?.isAuthenticated &&
      !jiraConfig?.projectKey &&
      (!jiraConfig?.availableProjects || jiraConfig.availableProjects.length === 0)
    ) {
      vscode.postMessage({
        type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS,
        siteUrl: jiraConfig.siteUrl,
        email: jiraConfig.email,
      });
    }
  }, [jiraConfig?.isAuthenticated, jiraConfig?.projectKey, jiraConfig?.availableProjects, jiraConfig?.siteUrl, jiraConfig?.email]);

  const submitCredentials = () => {
    const site = siteInput.trim();
    const email = emailInput.trim();
    const token = tokenInput.trim();
    if (!site || !email || !token) return;
    batchUpdateConfig('jira', {
      siteUrl: site,
      email,
      isConnecting: true,
      statusMessage: 'Verifying credentials…',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.SAVE_JIRA_CREDENTIALS,
      siteUrl: site,
      email,
      apiToken: token,
    });
    setTokenInput('');
  };

  const fetchProjects = () => {
    batchUpdateConfig('jira', {
      isConnecting: true,
      statusMessage: 'Fetching available projects...',
      messageType: 'success',
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS,
      siteUrl: jiraConfig.siteUrl,
      email: jiraConfig.email,
    });
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
            <div className='pat-connect'>
              <p className='description-text'>
                Connect Jira with an API token from your Atlassian account
                (id.atlassian.com → Security → API tokens).
              </p>
              <div className='form-group'>
                <label>Jira site URL</label>
                <input
                  type='text'
                  value={siteInput}
                  onChange={(e) => setSiteInput(e.target.value)}
                  placeholder='yourcompany.atlassian.net'
                />
              </div>
              <div className='form-group'>
                <label>Email</label>
                <input
                  type='email'
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  placeholder='you@yourcompany.com'
                />
              </div>
              <div className='form-group'>
                <label>API token</label>
                <input
                  type='password'
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder='Paste your Jira API token'
                />
              </div>
              <button
                className='primary-button-full'
                onClick={submitCredentials}
                disabled={!siteInput.trim() || !emailInput.trim() || !tokenInput.trim() || jiraConfig?.isConnecting}
              >
                {jiraConfig?.isConnecting ? 'Verifying…' : 'Connect'}
              </button>
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
                <label>Site</label>
                <div className='password-input-container'>
                  <input
                    type={showEmail ? 'text' : 'password'}
                    value={jiraConfig.siteUrl || ''}
                    readOnly
                  />
                  <button
                    type='button'
                    className='password-toggle-btn'
                    onClick={() => setShowEmail(!showEmail)}
                    title={showEmail ? 'Hide site URL' : 'Show site URL'}
                  >
                    {showEmail ? (
                      <svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'/><path d='M14.084 14.158a3 3 0 0 1-4.242-4.242'/><path d='M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'/><path d='m2 2 20 20'/></svg>
                    ) : (
                      <svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'/><circle cx='12' cy='12' r='3'/></svg>
                    )}
                  </button>
                </div>
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
