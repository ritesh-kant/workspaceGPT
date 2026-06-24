import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { clearStatusMessageAfterDelay } from './utils';
import { DeploymentConfig } from '../../types';
import { MESSAGE_TYPES } from '../../constants';

/**
 * Settings → Deployment: connect the write-scoped providers used by deployment
 * automation (GitHub App for mach PRs/tags/releases, Vercel for frontend env).
 * These credentials live only in the VS Code master and are never shared to the
 * Chrome extension.
 */
const DeploymentSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const dep = config.deployment || ({} as DeploymentConfig);

  const [vercelProjects, setVercelProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | undefined>();

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case MESSAGE_TYPES.GITHUB_CONNECTION_STATUS:
          batchUpdateConfig('deployment', {
            githubConnected: !!message.connected,
            githubInstallationId: message.installationId,
            isConnectingGithub: false,
          });
          break;
        case MESSAGE_TYPES.GITHUB_INSTALL_SUCCESS:
          batchUpdateConfig('deployment', {
            githubConnected: true,
            githubInstallationId: message.installationId,
            isConnectingGithub: false,
            messageType: 'success',
            statusMessage: 'GitHub App connected',
          });
          clearStatusMessageAfterDelay('deployment', 'statusMessage');
          break;
        case MESSAGE_TYPES.GITHUB_INSTALL_ERROR:
          // Errors persist (no auto-clear) so a failed connect is actually
          // readable; the next connect attempt overwrites it.
          batchUpdateConfig('deployment', {
            isConnectingGithub: false,
            messageType: 'error',
            statusMessage: message.error || 'GitHub connection failed',
          });
          break;

        case MESSAGE_TYPES.VERCEL_CONNECTION_STATUS:
          batchUpdateConfig('deployment', {
            vercelConnected: !!message.connected,
            vercelTeamId: message.teamId,
            isConnectingVercel: false,
          });
          break;
        case MESSAGE_TYPES.VERCEL_OAUTH_SUCCESS:
          batchUpdateConfig('deployment', {
            vercelConnected: true,
            vercelTeamId: message.teamId,
            isConnectingVercel: false,
            messageType: 'success',
            statusMessage: 'Vercel connected',
          });
          clearStatusMessageAfterDelay('deployment', 'statusMessage');
          break;
        case MESSAGE_TYPES.VERCEL_OAUTH_ERROR:
          // Errors persist (no auto-clear); the next connect attempt clears it.
          batchUpdateConfig('deployment', {
            isConnectingVercel: false,
            messageType: 'error',
            statusMessage: message.error || 'Vercel connection failed',
          });
          break;

        case MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS_RESULT:
          batchUpdateConfig('deployment', {
            isTesting: false,
            testResults: message.results || {},
          });
          break;

        case MESSAGE_TYPES.GET_VERCEL_PROJECTS_RESPONSE:
          setProjectsLoading(false);
          if (message.ok) {
            setVercelProjects(message.projects || []);
            setProjectsError(undefined);
          } else {
            setProjectsError(message.error || 'Failed to load Vercel projects');
          }
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Ask the extension for the current connection state when the section opens.
  useEffect(() => {
    if (dep.isDeploymentEnabled) {
      vscode.postMessage({ type: MESSAGE_TYPES.CHECK_GITHUB_CONNECTION });
      vscode.postMessage({ type: MESSAGE_TYPES.CHECK_VERCEL_CONNECTION });
    }
  }, [dep.isDeploymentEnabled]);

  const loadVercelProjects = () => {
    setProjectsLoading(true);
    setProjectsError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.GET_VERCEL_PROJECTS });
  };

  // Populate the project dropdown once Vercel is connected.
  useEffect(() => {
    if (dep.isDeploymentEnabled && dep.vercelConnected) {
      loadVercelProjects();
    }
  }, [dep.isDeploymentEnabled, dep.vercelConnected]);

  const connectGithub = () => {
    batchUpdateConfig('deployment', {
      isConnectingGithub: true,
      statusMessage: 'Opening GitHub App install…',
      messageType: 'success',
    });
    vscode.postMessage({ type: MESSAGE_TYPES.START_GITHUB_INSTALL });
  };

  const disconnectGithub = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.DISCONNECT_GITHUB });
  };

  const connectVercel = () => {
    batchUpdateConfig('deployment', {
      isConnectingVercel: true,
      statusMessage: 'Opening Vercel authorization…',
      messageType: 'success',
    });
    vscode.postMessage({ type: MESSAGE_TYPES.START_VERCEL_OAUTH });
  };

  const disconnectVercel = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.DISCONNECT_VERCEL });
  };

  const testConnections = () => {
    batchUpdateConfig('deployment', { isTesting: true, testResults: undefined });
    vscode.postMessage({ type: MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS });
  };

  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateConfig('deployment', 'isDeploymentEnabled', e.target.checked);
  };

  const renderProvider = (
    label: string,
    subtitle: string,
    connected: boolean,
    connecting: boolean,
    onConnect: () => void,
    onDisconnect: () => void,
    testKey: string,
  ) => {
    const test = dep.testResults?.[testKey];
    return (
      <div className="form-group" style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <div>
            <div style={{ fontWeight: 500 }}>{label}</div>
            <div style={{ fontSize: '0.8em', color: '#888' }}>{subtitle}</div>
          </div>
          {connected ? (
            <button onClick={onDisconnect} className="disconnect-button">Disconnect</button>
          ) : (
            <button onClick={onConnect} disabled={connecting}>
              {connecting ? '⏳ Connecting…' : '🔗 Connect'}
            </button>
          )}
        </div>
        <div style={{ fontSize: '0.82em', marginTop: '4px' }}>
          {connected ? (
            <span style={{ color: '#4ecca3' }}>✅ Connected</span>
          ) : (
            <span style={{ color: '#888' }}>Not connected</span>
          )}
          {test && (
            <span style={{ marginLeft: '10px', color: test.ok ? '#4ecca3' : '#e74c3c' }}>
              {test.ok ? '• test passed' : `• test failed${test.detail ? `: ${test.detail}` : ''}`}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="settings-section">
      <div className="section-header">
        <h3>Deployment Automation</h3>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={!!dep.isDeploymentEnabled}
            onChange={handleToggleChange}
          />
          <span className="slider round"></span>
        </label>
      </div>

      {dep.isDeploymentEnabled && (
        <div className="settings-form">
          <p style={{ color: '#a0a0a0', margin: '0 0 12px 0', fontSize: '0.85em', lineHeight: 1.6 }}>
            Write-scoped credentials, held only here in VS Code — never included in the
            Chrome share code.
          </p>

          <div className="form-group" style={{ marginBottom: '14px' }}>
            <label style={{ fontWeight: 500, display: 'block', marginBottom: '4px' }}>
              Release Roster page
            </label>
            <input
              type="text"
              value={dep.rosterPageUrl || ''}
              placeholder="https://your-site.atlassian.net/wiki/spaces/REL/pages/123456/Roster"
              onChange={(e) => updateConfig('deployment', 'rosterPageUrl', e.target.value)}
              style={{ width: '100%' }}
            />
            <div style={{ fontSize: '0.8em', color: '#888', marginTop: '4px' }}>
              Confluence page mapping each date → release version. Used to resolve “today’s
              release”. Requires Confluence connected under Settings → Confluence.
            </div>
          </div>

          {renderProvider(
            'GitHub App',
            'mach PRs, tags & releases',
            !!dep.githubConnected,
            !!dep.isConnectingGithub,
            connectGithub,
            disconnectGithub,
            'github',
          )}

          {renderProvider(
            'Vercel',
            'frontend env vars',
            !!dep.vercelConnected,
            !!dep.isConnectingVercel,
            connectVercel,
            disconnectVercel,
            'vercel',
          )}

          {dep.vercelConnected && (
            <div
              className="form-group"
              style={{ margin: '4px 0 14px', paddingLeft: 10, borderLeft: '2px solid #2a2a3e' }}
            >
              <label style={{ fontWeight: 500, display: 'block', marginBottom: '4px' }}>
                Vercel project
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  value={dep.vercelProjectId || ''}
                  onChange={(e) => {
                    const id = e.target.value;
                    const name = vercelProjects.find((p) => p.id === id)?.name || '';
                    batchUpdateConfig('deployment', { vercelProjectId: id, vercelProjectName: name });
                  }}
                  disabled={projectsLoading || vercelProjects.length === 0}
                  style={{ flex: 1 }}
                >
                  <option value="">
                    {projectsLoading
                      ? 'Loading projects…'
                      : vercelProjects.length === 0
                        ? 'No projects found'
                        : 'Select a project…'}
                  </option>
                  {vercelProjects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button onClick={loadVercelProjects} disabled={projectsLoading} title="Refresh project list">
                  ↻
                </button>
              </div>
              {projectsError && (
                <div style={{ fontSize: '0.8em', color: '#e74c3c', marginTop: 4 }}>{projectsError}</div>
              )}

              <label style={{ fontWeight: 500, display: 'block', margin: '12px 0 4px' }}>
                Environment mapping
              </label>
              <div style={{ fontSize: '0.8em', color: '#888', marginBottom: 6 }}>
                Which Vercel environment each release environment writes to (e.g. <code>preview</code>,{' '}
                <code>production</code>, or a custom environment name).
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>stage →</div>
                  <input
                    type="text"
                    value={dep.vercelEnvStage ?? ''}
                    placeholder="preview"
                    onChange={(e) => updateConfig('deployment', 'vercelEnvStage', e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>prod →</div>
                  <input
                    type="text"
                    value={dep.vercelEnvProd ?? ''}
                    placeholder="production"
                    onChange={(e) => updateConfig('deployment', 'vercelEnvProd', e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 12, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!dep.vercelPerEnvValues}
                  onChange={(e) => updateConfig('deployment', 'vercelPerEnvValues', e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ fontSize: '0.82em' }}>
                  Per-environment values
                  <div style={{ fontSize: '0.92em', color: '#888' }}>
                    When a variable is shared across multiple environments, split it into a dedicated
                    record for this environment instead of updating all linked environments. Otherwise
                    an update changes the value everywhere it's linked.
                  </div>
                </span>
              </label>
            </div>
          )}

          <button
            onClick={testConnections}
            disabled={dep.isTesting || (!dep.githubConnected && !dep.vercelConnected)}
            style={{ marginTop: '4px' }}
          >
            {dep.isTesting ? '⏳ Testing…' : '🔌 Test all connections'}
          </button>

          {dep.statusMessage && (
            <div
              className={`status-message ${dep.messageType === 'success' ? 'success' : 'error'}`}
              style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}
            >
              <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{dep.statusMessage}</span>
              {dep.messageType === 'error' && (
                <button
                  onClick={() => updateConfig('deployment', 'statusMessage', '')}
                  aria-label="Dismiss"
                  style={{
                    background: 'none', border: 'none', color: 'inherit',
                    cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: '1.1em', flexShrink: 0,
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DeploymentSettings;
