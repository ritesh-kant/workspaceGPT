import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { clearStatusMessageAfterDelay } from './utils';
import { DeploymentConfig } from '../../types';
import SearchableDropdown from './SearchableDropdown';
import {
  MESSAGE_TYPES,
  MARS_MACH_PRESET,
  MARS_PIPELINE_PRESET,
  legacyToDescriptor,
} from '../../constants';
import type { PipelineDescriptor, PipelineSource, ActionProvider } from '../../constants';

/** Default config for a freshly-added action of each provider. */
function defaultActionConfig(provider: ActionProvider): Record<string, any> {
  if (provider === 'vercel-config') {
    return { projectId: '', projectName: '', envStage: 'preview', envProd: 'production', perEnvValues: false };
  }
  if (provider === 'github-workflow-dispatch') {
    return {
      repo: MARS_MACH_PRESET,
      brand: 'mms',
      sourceEnv: '',
      fromBranch: 'main',
      envStage: 'stage',
      envProd: 'prod',
      updateMainYml: true,
      webappVercelProjectId: '',
    };
  }
  return { owner: '', repo: '', filePath: 'main.yml', strategy: 'env-var-merge' };
}

const PROVIDER_LABEL: Record<ActionProvider, string> = {
  'vercel-config': 'Vercel — env config',
  'github-workflow-dispatch': 'GitHub — workflow dispatch',
  'repo-file-patch': 'Repo — file patch',
};

const SOURCE_LABEL: Record<PipelineSource['provider'], string> = {
  'confluence-roster': 'Confluence roster',
  file: 'JSON file (Git repo)',
  jira: 'Jira',
  manual: 'Manual entry',
  none: 'None',
};

/**
 * Settings → Deployment pipeline. A generic, CodePipeline-shaped editor: a
 * pluggable Source, then Stages of provider Actions. No provider is hardwired —
 * Mars MMS is just a preset. Everything is stored in one pipeline descriptor.
 */
const DeploymentSettings: React.FC = () => {
  const { config, batchUpdateConfig, updateConfig } = useSettingsStore();
  const vscode = VSCodeAPI();
  const dep = config.deployment || ({} as DeploymentConfig);

  const [vercelProjects, setVercelProjects] = useState<{ id: string; name: string }[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState<string | undefined>();

  const [machToken, setMachToken] = useState('');
  const [machSaving, setMachSaving] = useState(false);
  const [machStatus, setMachStatus] = useState<{
    connected: boolean;
    repos?: { monorepo: boolean; stage: boolean };
    detail?: string;
  }>({ connected: false });

  const [ghLists, setGhLists] = useState<{
    orgs: string[]; repos: string[]; workflows: string[]; branches: string[];
  }>({ orgs: [], repos: [], workflows: [], branches: [] });
  const [ghLoading, setGhLoading] = useState<string | undefined>();
  const [ghError, setGhError] = useState<string | undefined>();

  const [rosterCols, setRosterCols] = useState<{
    headers: string[];
    guess: { date?: string; version?: string; env?: string; pilot?: string };
  }>({ headers: [], guess: {} });
  const [rosterColsLoading, setRosterColsLoading] = useState(false);
  const [rosterColsError, setRosterColsError] = useState<string | undefined>();

  // ---- descriptor (single source of truth) + immutable edit helpers ----
  const pipeline: PipelineDescriptor = dep.pipeline ?? legacyToDescriptor(dep);
  const savePipeline = (p: PipelineDescriptor) => updateConfig('deployment', 'pipeline', p);
  const source = pipeline.source;
  const setSource = (patch: Partial<PipelineSource>) =>
    savePipeline({ ...pipeline, source: { ...pipeline.source, ...patch } });
  const setActionConfig = (si: number, ai: number, patch: Record<string, any>) =>
    savePipeline({
      ...pipeline,
      stages: pipeline.stages.map((s, i) =>
        i !== si
          ? s
          : { ...s, actions: s.actions.map((a, j) => (j !== ai ? a : { ...a, config: { ...a.config, ...patch } })) },
      ),
    });
  const setStage = (si: number, patch: Record<string, any>) =>
    savePipeline({ ...pipeline, stages: pipeline.stages.map((s, i) => (i !== si ? s : { ...s, ...patch })) });
  const addStage = () =>
    savePipeline({
      ...pipeline,
      stages: [...pipeline.stages, { name: `Stage ${pipeline.stages.length + 1}`, gate: 'manual', actions: [] }],
    });
  const removeStage = (si: number) =>
    savePipeline({ ...pipeline, stages: pipeline.stages.filter((_, i) => i !== si) });
  const addAction = (si: number, provider: ActionProvider) =>
    savePipeline({
      ...pipeline,
      stages: pipeline.stages.map((s, i) =>
        i !== si
          ? s
          : {
              ...s,
              actions: [
                ...s.actions,
                { id: `${provider}-${Date.now()}`, provider, category: 'deploy' as const, config: defaultActionConfig(provider) },
              ],
            },
      ),
    });
  const removeAction = (si: number, ai: number) =>
    savePipeline({
      ...pipeline,
      stages: pipeline.stages.map((s, i) =>
        i !== si ? s : { ...s, actions: s.actions.filter((_, j) => j !== ai) },
      ),
    });
  const applyPreset = (name: string) => {
    if (name === 'mars') savePipeline(MARS_PIPELINE_PRESET);
    else if (name === 'blank') savePipeline({ name: 'Blank', source: { provider: 'none' }, stages: [] });
  };

  const environments = pipeline.environments ?? [];
  const setEnvironments = (list: any[]) => savePipeline({ ...pipeline, environments: list });
  const addEnv = () => setEnvironments([...environments, { name: '', autoMerge: false }]);
  const updateEnv = (i: number, patch: Record<string, any>) =>
    setEnvironments(environments.map((e, j) => (j !== i ? e : { ...e, ...patch })));
  const removeEnv = (i: number) => setEnvironments(environments.filter((_, j) => j !== i));

  // First github-workflow-dispatch action — drives the shared topology discovery.
  let machSi = -1;
  let machAi = -1;
  pipeline.stages.forEach((s, si) =>
    s.actions.forEach((a, ai) => {
      if (machSi < 0 && a.provider === 'github-workflow-dispatch') {
        machSi = si;
        machAi = ai;
      }
    }),
  );
  const machAction = machSi >= 0 ? pipeline.stages[machSi].actions[machAi] : undefined;
  const repoCfg = { ...MARS_MACH_PRESET, ...(machAction?.config?.repo ?? {}) };
  const setRepoField = (key: string, value: string) => {
    if (machSi < 0) return;
    setActionConfig(machSi, machAi, { repo: { ...repoCfg, [key]: value } });
  };

  const setRosterCol = (key: string, value: string) =>
    setSource({ rosterColumns: { ...(source.rosterColumns || {}), [key]: value } });
  const detectRosterColumns = () => {
    setRosterColsLoading(true);
    setRosterColsError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.DISCOVER_ROSTER_COLUMNS });
  };
  const discover = (
    kind: 'orgs' | 'repos' | 'workflows' | 'branches',
    params: { owner?: string; repo?: string } = {},
  ) => {
    setGhLoading(kind);
    setGhError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.DISCOVER_GITHUB, kind, ...params });
  };

  // Derived connections — only what this pipeline actually uses.
  const usedProviders = new Set(pipeline.stages.flatMap((s) => s.actions.map((a) => a.provider)));
  const needsGithub =
    usedProviders.has('github-workflow-dispatch') ||
    usedProviders.has('repo-file-patch') ||
    source.provider === 'file';
  const needsVercel = usedProviders.has('vercel-config');
  const needsConfluence = source.provider === 'confluence-roster';

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
          batchUpdateConfig('deployment', {
            isConnectingVercel: false,
            messageType: 'error',
            statusMessage: message.error || 'Vercel connection failed',
          });
          break;

        case MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS_RESULT:
          batchUpdateConfig('deployment', { isTesting: false, testResults: message.results || {} });
          break;

        case MESSAGE_TYPES.MACH_TOKEN_STATUS:
          setMachSaving(false);
          setMachStatus({ connected: !!message.connected, repos: message.repos, detail: message.detail });
          if (message.connected) setMachToken('');
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

        case MESSAGE_TYPES.DISCOVER_GITHUB_RESPONSE:
          setGhLoading(undefined);
          if (message.ok && message.kind) {
            setGhLists((prev) => ({ ...prev, [message.kind]: message.items || [] }));
            setGhError(undefined);
          } else {
            setGhError(message.error || 'GitHub discovery failed');
          }
          break;

        case MESSAGE_TYPES.DISCOVER_ROSTER_COLUMNS_RESPONSE:
          setRosterColsLoading(false);
          if (message.ok) {
            setRosterCols({ headers: message.headers || [], guess: message.guess || {} });
            setRosterColsError(undefined);
          } else {
            setRosterColsError(message.error || 'Could not read roster columns');
          }
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (dep.isDeploymentEnabled) {
      vscode.postMessage({ type: MESSAGE_TYPES.CHECK_GITHUB_CONNECTION });
      vscode.postMessage({ type: MESSAGE_TYPES.CHECK_VERCEL_CONNECTION });
      vscode.postMessage({ type: MESSAGE_TYPES.CHECK_MACH_TOKEN });
    }
  }, [dep.isDeploymentEnabled]);

  const loadVercelProjects = () => {
    setProjectsLoading(true);
    setProjectsError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.GET_VERCEL_PROJECTS });
  };

  useEffect(() => {
    if (dep.isDeploymentEnabled && dep.vercelConnected && needsVercel) loadVercelProjects();
  }, [dep.isDeploymentEnabled, dep.vercelConnected, needsVercel]);

  // Cascading mach-topology discovery: orgs → repos(owner) → workflows+branches(repo).
  useEffect(() => {
    if (dep.isDeploymentEnabled && machStatus.connected && machSi >= 0) discover('orgs');
  }, [dep.isDeploymentEnabled, machStatus.connected, machSi]);
  useEffect(() => {
    if (machStatus.connected && machSi >= 0 && repoCfg.monorepoOwner) {
      discover('repos', { owner: repoCfg.monorepoOwner });
    }
  }, [machStatus.connected, machSi, repoCfg.monorepoOwner]);
  useEffect(() => {
    if (machStatus.connected && machSi >= 0 && repoCfg.monorepoOwner && repoCfg.monorepoRepo) {
      discover('workflows', { owner: repoCfg.monorepoOwner, repo: repoCfg.monorepoRepo });
      discover('branches', { owner: repoCfg.monorepoOwner, repo: repoCfg.monorepoRepo });
    }
  }, [machStatus.connected, machSi, repoCfg.monorepoOwner, repoCfg.monorepoRepo]);

  const connectGithub = () => {
    batchUpdateConfig('deployment', { isConnectingGithub: true, statusMessage: 'Opening GitHub App install…', messageType: 'success' });
    vscode.postMessage({ type: MESSAGE_TYPES.START_GITHUB_INSTALL });
  };
  const disconnectGithub = () => vscode.postMessage({ type: MESSAGE_TYPES.DISCONNECT_GITHUB });
  const connectVercel = () => {
    batchUpdateConfig('deployment', { isConnectingVercel: true, statusMessage: 'Opening Vercel authorization…', messageType: 'success' });
    vscode.postMessage({ type: MESSAGE_TYPES.START_VERCEL_OAUTH });
  };
  const disconnectVercel = () => vscode.postMessage({ type: MESSAGE_TYPES.DISCONNECT_VERCEL });
  const saveMachToken = () => {
    if (!machToken.trim()) return;
    setMachSaving(true);
    vscode.postMessage({ type: MESSAGE_TYPES.SET_MACH_TOKEN, token: machToken });
  };
  const clearMachToken = () => vscode.postMessage({ type: MESSAGE_TYPES.CLEAR_MACH_TOKEN });
  const testConnections = () => {
    batchUpdateConfig('deployment', { isTesting: true, testResults: undefined });
    vscode.postMessage({ type: MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS });
  };
  const handleToggleChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    updateConfig('deployment', 'isDeploymentEnabled', e.target.checked);

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
        <div className="dep-connection">
          <div>
            <div className="dep-connection-title">{label}</div>
            <div className="dep-field-label" style={{ marginBottom: 0 }}>{subtitle}</div>
          </div>
          {connected ? (
            <button onClick={onDisconnect} className="disconnect-button">Disconnect</button>
          ) : (
            <button onClick={onConnect} disabled={connecting}>{connecting ? '⏳ Connecting…' : '🔗 Connect'}</button>
          )}
        </div>
        <div className="dep-status-line">
          {connected ? <span className="dep-ok">✅ Connected</span> : <span className="dep-muted">Not connected</span>}
          {test && (
            <span style={{ marginLeft: '10px' }} className={test.ok ? 'dep-ok' : 'dep-err'}>
              {test.ok ? '• test passed' : `• test failed${test.detail ? `: ${test.detail}` : ''}`}
            </span>
          )}
        </div>
      </div>
    );
  };

  const topoSelect = (label: string, field: string) => {
    const list = (ghLists as Record<string, string[]>)[
      field === 'monorepoOwner' || field === 'destOwner' ? 'orgs' : field === 'monorepoRepo' ? 'repos' : field === 'workflowName' ? 'workflows' : 'branches'
    ];
    const current = (repoCfg as Record<string, string>)[field] || '';
    const options = [
      ...(current && !list.includes(current) ? [{ value: current, label: `${current} (current)` }] : []),
      ...list.map((o) => ({ value: o, label: o })),
    ];
    return (
      <div className="dep-field">
        <div className="dep-field-label">{label}</div>
        <SearchableDropdown
          value={current}
          options={options}
          onChange={(v) => setRepoField(field, v)}
          placeholder={list.length ? 'Select…' : 'Connect token / loading…'}
          disabled={list.length === 0 && !current}
          searchPlaceholder="Search…"
        />
      </div>
    );
  };

  const renderVercelAction = (si: number, ai: number, cfg: Record<string, any>) => {
    const projectOptions = [
      ...(cfg.projectId && !vercelProjects.some((p) => p.id === cfg.projectId)
        ? [{ value: cfg.projectId, label: `${cfg.projectName || cfg.projectId} (current)` }]
        : []),
      ...vercelProjects.map((p) => ({ value: p.id, label: p.name })),
    ];
    return (
      <>
        <div className="dep-field">
          <div className="dep-field-label">Vercel project</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SearchableDropdown
                value={cfg.projectId || ''}
                options={projectOptions}
                onChange={(id) => {
                  const name = vercelProjects.find((p) => p.id === id)?.name || '';
                  setActionConfig(si, ai, { projectId: id, projectName: name });
                }}
                disabled={projectsLoading || vercelProjects.length === 0}
                placeholder={projectsLoading ? 'Loading…' : vercelProjects.length === 0 ? 'Connect Vercel' : 'Select project'}
                searchPlaceholder="Search projects…"
              />
            </div>
            <button className="dep-icon-button" onClick={loadVercelProjects} disabled={projectsLoading} title="Refresh">↻</button>
          </div>
          {projectsError && <div className="dep-inline-note dep-err">{projectsError}</div>}
        </div>
        <div className="dep-row">
          <div>
            <div className="dep-field-label">stage → vercel env</div>
            <input value={cfg.envStage ?? ''} placeholder="preview" onChange={(e) => setActionConfig(si, ai, { envStage: e.target.value })} style={{ width: '100%' }} />
          </div>
          <div>
            <div className="dep-field-label">prod → vercel env</div>
            <input value={cfg.envProd ?? ''} placeholder="production" onChange={(e) => setActionConfig(si, ai, { envProd: e.target.value })} style={{ width: '100%' }} />
          </div>
        </div>
        <label className="dep-checkbox">
          <input type="checkbox" checked={!!cfg.perEnvValues} onChange={(e) => setActionConfig(si, ai, { perEnvValues: e.target.checked })} />
          Per-environment values (split shared vars)
        </label>
      </>
    );
  };

  const renderMachAction = (si: number, ai: number, cfg: Record<string, any>) => (
    <>
      <div className={`dep-inline-note ${machStatus.connected ? 'dep-ok' : 'dep-warn'}`} style={{ marginTop: 0, marginBottom: 8 }}>
        {machStatus.connected ? '✅ token reaches both repos' : 'Set a GitHub PAT below (Connections) to enable.'}
      </div>
      <div className="dep-row">
        <div>
          <div className="dep-field-label">Brand</div>
          <input value={cfg.brand ?? ''} placeholder="mms" onChange={(e) => setActionConfig(si, ai, { brand: e.target.value })} style={{ width: '100%' }} />
        </div>
        <div>
          <div className="dep-field-label">Source env (from)</div>
          <input value={cfg.sourceEnv ?? ''} placeholder="test01" onChange={(e) => setActionConfig(si, ai, { sourceEnv: e.target.value })} style={{ width: '100%' }} />
        </div>
        <div>
          <div className="dep-field-label">Source branch</div>
          <input value={cfg.fromBranch ?? ''} placeholder="main" onChange={(e) => setActionConfig(si, ai, { fromBranch: e.target.value })} style={{ width: '100%' }} />
        </div>
      </div>
      <div className="dep-row" style={{ marginTop: 10 }}>
        <div>
          <div className="dep-field-label">stage → dest env</div>
          <input value={cfg.envStage ?? ''} placeholder="stage" onChange={(e) => setActionConfig(si, ai, { envStage: e.target.value })} style={{ width: '100%' }} />
        </div>
        <div>
          <div className="dep-field-label">prod → dest env</div>
          <input value={cfg.envProd ?? ''} placeholder="prod" onChange={(e) => setActionConfig(si, ai, { envProd: e.target.value })} style={{ width: '100%' }} />
        </div>
      </div>
      <label className="dep-checkbox">
        <input type="checkbox" checked={cfg.updateMainYml !== false} onChange={(e) => setActionConfig(si, ai, { updateMainYml: e.target.checked })} />
        Update main.yml env vars
      </label>
      {si === machSi && ai === machAi && (
        <details className="dep-details">
          <summary>Repo topology (auto-detected · defaults to preset)</summary>
          <div className="dep-details-body">
            {topoSelect('Monorepo owner (org)', 'monorepoOwner')}
            {topoSelect('Monorepo repo', 'monorepoRepo')}
            {topoSelect('Sync workflow', 'workflowName')}
            {topoSelect('Workflow branch (ref)', 'monorepoRef')}
            {topoSelect('Env repos owner', 'destOwner')}
            <div className="dep-field">
              <div className="dep-field-label">Env repo name template</div>
              <input value={repoCfg.repoTemplate || ''} placeholder="aws-{brand}-phoenix-{env}-mach" onChange={(e) => setRepoField('repoTemplate', e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => discover('orgs')} disabled={!!ghLoading}>{ghLoading ? `Loading ${ghLoading}…` : '↻ Re-detect'}</button>
              {ghError && <span className="dep-warn" style={{ fontSize: '0.78em' }}>{ghError}</span>}
            </div>
          </div>
        </details>
      )}
    </>
  );

  const ADD_PROVIDERS: ActionProvider[] = ['vercel-config', 'github-workflow-dispatch', 'repo-file-patch'];

  return (
    <div className="settings-section">
      <div className="section-header">
        <h3>Deployment pipeline</h3>
        <label className="toggle-switch">
          <input type="checkbox" checked={!!dep.isDeploymentEnabled} onChange={handleToggleChange} />
          <span className="slider round"></span>
        </label>
      </div>

      {dep.isDeploymentEnabled && (
        <div className="settings-form">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
            <p className="dep-hint" style={{ flex: 1 }}>
              Build from a preset or from blank. No provider is hardwired — write creds stay in VS Code only.
            </p>
            <div style={{ flex: '0 0 150px' }}>
              <SearchableDropdown
                value=""
                triggerLabel={`Preset: ${pipeline.name || 'Custom'}`}
                options={[
                  { value: 'mars', label: 'Mars MMS', subtitle: 'Load the full Mars preset' },
                  { value: 'blank', label: 'Blank', subtitle: 'Start from an empty pipeline' },
                ]}
                onChange={applyPreset}
              />
            </div>
          </div>

          {/* SOURCE */}
          <div className="dep-group-label">Source</div>
          <div className="form-group" style={{ marginBottom: 4 }}>
            <SearchableDropdown
              value={source.provider}
              options={(Object.keys(SOURCE_LABEL) as PipelineSource['provider'][]).map((p) => ({
                value: p,
                label: SOURCE_LABEL[p],
              }))}
              onChange={(v) => setSource({ provider: v as PipelineSource['provider'] })}
            />

            {source.provider === 'confluence-roster' && (
              <div style={{ marginTop: 10 }}>
                <input
                  type="text"
                  value={source.rosterPageUrl || ''}
                  placeholder="https://your-site.atlassian.net/wiki/.../Roster"
                  onChange={(e) => setSource({ rosterPageUrl: e.target.value })}
                  style={{ width: '100%' }}
                />
                <div className="dep-inline-note dep-muted">
                  Confluence page mapping date → release version. Requires Confluence connected under Settings → Confluence.
                </div>
                {source.rosterPageUrl && (
                  <details className="dep-details">
                    <summary>Column mapping (auto-detected)</summary>
                    <div className="dep-details-body">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                        <button onClick={detectRosterColumns} disabled={rosterColsLoading}>{rosterColsLoading ? 'Detecting…' : '↻ Detect columns'}</button>
                        {rosterColsError && <span className="dep-warn" style={{ fontSize: '0.78em' }}>{rosterColsError}</span>}
                      </div>
                      {(['date', 'version', 'env', 'pilot'] as const).map((field) => {
                        const current = (source.rosterColumns?.[field] ?? rosterCols.guess[field]) || '';
                        const options = [
                          ...(current && !rosterCols.headers.includes(current) ? [{ value: current, label: `${current} (current)` }] : []),
                          ...rosterCols.headers.map((h) => ({ value: h, label: h })),
                        ];
                        return (
                          <div key={field} className="dep-field">
                            <div className="dep-field-label">{field} column</div>
                            <SearchableDropdown
                              value={current}
                              options={options}
                              onChange={(v) => setRosterCol(field, v)}
                              disabled={rosterCols.headers.length === 0}
                              placeholder={rosterCols.headers.length ? 'Auto-detect' : 'Detect first…'}
                              clearable
                              clearLabel="-- Auto-detect --"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
                <label className="dep-checkbox">
                  <input type="checkbox" checked={!!source.aiAssistParsing} onChange={(e) => setSource({ aiAssistParsing: e.target.checked })} />
                  <span>
                    AI-assisted page reading (fallback)
                    <div className="dep-muted" style={{ fontSize: '0.92em', marginTop: 2 }}>
                      If header matching fails, use your chat model (Settings → Model) to read the page. Validated and shown for approval before apply.
                    </div>
                  </span>
                </label>
              </div>
            )}
            {source.provider === 'file' && (
              <div style={{ marginTop: 10 }}>
                <div className="dep-row">
                  <div>
                    <div className="dep-field-label">Repo owner</div>
                    <input type="text" value={source.fileRepoOwner || ''} placeholder="my-org" onChange={(e) => setSource({ fileRepoOwner: e.target.value })} style={{ width: '100%' }} />
                  </div>
                  <div>
                    <div className="dep-field-label">Repo</div>
                    <input type="text" value={source.fileRepoName || ''} placeholder="release-config" onChange={(e) => setSource({ fileRepoName: e.target.value })} style={{ width: '100%' }} />
                  </div>
                  <div style={{ flex: '0 0 90px' }}>
                    <div className="dep-field-label">Branch</div>
                    <input type="text" value={source.fileRef || ''} placeholder="main" onChange={(e) => setSource({ fileRef: e.target.value })} style={{ width: '100%' }} />
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <div className="dep-field-label">File path</div>
                  <input type="text" value={source.filePath || ''} placeholder="releases.json" onChange={(e) => setSource({ filePath: e.target.value })} style={{ width: '100%' }} />
                </div>
                <div className="dep-inline-note dep-muted">
                  JSON file with a <code>releases[]</code> array (date, version, environment, config[]). Read via the GitHub PAT below.
                </div>
              </div>
            )}
            {(source.provider === 'manual' || source.provider === 'none' || source.provider === 'jira') && (
              <div className="dep-inline-note dep-muted">
                {source.provider === 'jira' ? 'Jira source is a reserved provider — not yet wired.' : source.provider === 'manual' ? 'You’ll enter the version/environment at run time in the Releases view.' : 'No source — desired state comes from the actions themselves (e.g. component promotion).'}
              </div>
            )}
          </div>

          {/* STAGES */}
          <div className="dep-group-label">Stages</div>
          {pipeline.stages.map((stage, si) => (
            <div key={si} className="dep-card">
              <div className="dep-card-header">
                <input value={stage.name} onChange={(e) => setStage(si, { name: e.target.value })} style={{ flex: 1, fontWeight: 500 }} />
                <div style={{ flex: '0 0 130px' }}>
                  <SearchableDropdown
                    value={stage.gate}
                    options={[
                      { value: 'manual', label: 'Manual gate' },
                      { value: 'auto', label: 'Auto' },
                    ]}
                    onChange={(v) => setStage(si, { gate: v })}
                  />
                </div>
                <button onClick={() => removeStage(si)} className="disconnect-button" title="Remove stage">✕</button>
              </div>

              {stage.actions.map((action, ai) => (
                <div key={action.id} className="dep-action-card">
                  <div className="dep-action-card-header">
                    <span className="dep-action-title">{PROVIDER_LABEL[action.provider]}</span>
                    <span className="dep-action-badge">
                      {action.category}
                      <button onClick={() => removeAction(si, ai)} className="disconnect-button" title="Remove action">✕</button>
                    </span>
                  </div>
                  {action.provider === 'vercel-config' && renderVercelAction(si, ai, action.config)}
                  {action.provider === 'github-workflow-dispatch' && renderMachAction(si, ai, action.config)}
                  {action.provider === 'repo-file-patch' && (
                    <div className="dep-muted" style={{ fontSize: '0.8em' }}>
                      File-patch action (e.g. main.yml env merge) — provider scaffold; commit wiring pending the action spec.
                    </div>
                  )}
                </div>
              ))}

              <div className="dep-add-actions">
                <span className="dep-add-label">+ action:</span>
                {ADD_PROVIDERS.map((p) => (
                  <button key={p} onClick={() => addAction(si, p)} style={{ fontSize: '0.78em' }}>{PROVIDER_LABEL[p].split(' — ')[0]}</button>
                ))}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
            <button onClick={addStage}>+ Add stage</button>
            <span className="dep-muted" style={{ fontSize: '0.74em' }}>switch · canary · verify · rollback — reserved</span>
          </div>

          {/* ENVIRONMENTS — promotion policy (auto-merge per env) */}
          <div className="dep-group-label">Environments · promotion policy</div>
          <div>
            {environments.length === 0 && (
              <div className="dep-muted" style={{ fontSize: '0.82em', marginBottom: 8 }}>
                None declared — promotions never auto-merge (safe default). Add one only to allow auto-merge for a specific environment.
              </div>
            )}
            {environments.map((env, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <input
                  value={env.name || ''}
                  placeholder="env name (e.g. stage)"
                  onChange={(e) => updateEnv(i, { name: e.target.value })}
                  style={{ flex: 1 }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8em', whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={env.autoMerge === true} onChange={(e) => updateEnv(i, { autoMerge: e.target.checked })} />
                  auto-merge
                </label>
                <button onClick={() => removeEnv(i)} className="disconnect-button" title="Remove">✕</button>
              </div>
            ))}
            <button onClick={addEnv} style={{ marginTop: 4 }}>+ Add environment</button>
          </div>

          {/* CONNECTIONS — derived from used providers */}
          <div className="dep-group-label">Connections</div>
          {!needsConfluence && !needsGithub && !needsVercel && (
            <div className="dep-muted" style={{ fontSize: '0.82em', marginBottom: 8 }}>Add a source or action to see the connections it needs.</div>
          )}
          {needsConfluence && (
            <div className="dep-muted" style={{ fontSize: '0.82em', marginBottom: 8 }}>Confluence — connect under Settings → Confluence.</div>
          )}
          {needsGithub && (
            <>
              {renderProvider('GitHub App', 'OAuth (optional hardening)', !!dep.githubConnected, !!dep.isConnectingGithub, connectGithub, disconnectGithub, 'github')}
              <div className="form-group" style={{ marginBottom: 12 }}>
                <div className="dep-connection-title">GitHub PAT (mach)</div>
                <div className="dep-muted" style={{ fontSize: '0.8em', marginBottom: 4 }}>Classic PAT (repo + workflow), SSO-authorized. Stored only here — never shared to Chrome.</div>
                {machStatus.connected ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="dep-ok" style={{ fontSize: '0.82em' }}>
                      ✅ connected{machStatus.repos && `${machStatus.repos.monorepo ? '' : ' · monorepo unreachable'}${machStatus.repos.stage ? '' : ' · env repo unreachable'}`}
                    </span>
                    <button onClick={clearMachToken} className="disconnect-button">Clear</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input type="password" value={machToken} placeholder="ghp_… (classic PAT)" onChange={(e) => setMachToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveMachToken(); }} autoComplete="off" style={{ flex: 1 }} />
                    <button onClick={saveMachToken} disabled={machSaving || !machToken.trim()}>{machSaving ? '⏳' : 'Save'}</button>
                  </div>
                )}
                {machStatus.detail && <div className="dep-warn dep-inline-note">{machStatus.detail}</div>}
              </div>
            </>
          )}
          {needsVercel && renderProvider('Vercel', 'frontend env vars', !!dep.vercelConnected, !!dep.isConnectingVercel, connectVercel, disconnectVercel, 'vercel')}

          <button onClick={testConnections} disabled={dep.isTesting} style={{ width: '100%', marginTop: 10 }}>
            {dep.isTesting ? '⏳ Testing…' : '🔌 Test all connections'}
          </button>
        </div>
      )}
    </div>
  );
};

export default DeploymentSettings;
