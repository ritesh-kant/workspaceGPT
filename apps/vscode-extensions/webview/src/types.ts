import type { PipelineDescriptor, DeploymentEnvironment } from './constants';
export type { DeploymentEnvironment };

export interface SettingsButtonProps {
  isVisible: boolean;
  onBack: () => void;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
}

export interface ConfluenceConfig {
  isConfluenceEnabled: boolean;
  isAuthenticated: boolean;
  siteName: string;
  cloudId: string;
  spaceKey: string;
  availableSpaces: ConfluenceSpace[];
  confluenceSyncProgress: number;
  confluenceIndexProgress: number;
  isSyncing: boolean;
  isIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
  messageType: 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
  lastSyncTime?: string;
  isConnecting?: boolean;
}

export interface AdoCurrentSprint {
  name: string;
  iterationPath: string;
  startDate: string;
  endDate: string;
}

export interface AdoConfig {
  isAdoEnabled?: boolean;
  isAuthenticated: boolean;
  orgName: string;
  projectName: string;
  teamName?: string;
  availableOrganizations?: { accountId: string; accountName: string }[];
  availableProjects: { id: string; name: string }[];
  lookbackMonths: number;
  userDisplayName?: string;
  currentSprint?: AdoCurrentSprint | null;
  adoSyncProgress: number;
  adoIndexProgress: number;
  isSyncing: boolean;
  isIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
  messageType: 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
  lastSyncTime?: string;
  isConnecting?: boolean;
}

/** Auth + discovery (P2/P4) + sync/indexing (P5) fields — sized like AdoConfig, minus sprint (that's P6, computed per-item rather than stored here). */
export interface JiraConfig {
  isJiraEnabled?: boolean;
  isAuthenticated: boolean;
  /** The connected site's real domain, discovered via OAuth — display only. */
  siteUrl: string;
  projectKey: string;
  projectName: string;
  availableProjects: { id: string; key: string; name: string }[];
  accountId?: string;
  displayName?: string;
  lookbackMonths: number;
  jiraSyncProgress: number;
  jiraIndexProgress: number;
  isSyncing: boolean;
  isIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
  messageType: 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
  lastSyncTime?: string;
  isConnecting?: boolean;
}

export interface DeploymentConnectionTest {
  ok: boolean;
  detail?: string;
}

export interface DeploymentConfig {
  /**
   * The pipeline descriptor — the single source of truth for the generic,
   * CodePipeline-shaped config (source + stages + actions). When present it
   * supersedes the legacy flat fields below; the handler migrates legacy
   * installs into one automatically.
   */
  pipeline?: PipelineDescriptor;
  /** Named presets — multiple saved pipeline configs, switchable via Settings. */
  pipelines?: PipelineDescriptor[];
  /** Which preset in `pipelines` is currently active (by `PipelineDescriptor.id`). */
  activePipelineId?: string;
  isDeploymentEnabled?: boolean;
  /** Confluence Release Roster page URL — source for resolving today's release. */
  rosterPageUrl?: string;
  /**
   * Explicit roster column mapping (from the discover-and-select dropdowns).
   * Any omitted column falls back to header auto-detection, so an unset mapping
   * behaves exactly as before — this just lets non-standard rosters work.
   */
  rosterColumns?: { date?: string; version?: string; env?: string; pilot?: string };
  /**
   * Opt-in: when the deterministic roster/release-page parse fails, fall back to
   * the configured chat model to read the page. AI output is validated and still
   * gated by the plan→approve review, so it never auto-applies a wrong value.
   */
  aiAssistParsing?: boolean;
  /**
   * Declared environments (N-ary). When present, drives env→target mapping and
   * per-env policy. When absent, the handler falls back to the legacy
   * `vercelEnv{Stage,Prod}` / `machEnv{Stage,Prod}` fields so existing configs
   * keep working unchanged.
   */
  environments?: DeploymentEnvironment[];
  githubConnected: boolean;
  githubInstallationId?: string;
  vercelConnected: boolean;
  vercelTeamId?: string;
  /** Vercel project (config-sync target) chosen from the live project list. */
  vercelProjectId?: string;
  vercelProjectName?: string;
  /** Maps the release environment to a Vercel environment (e.g. preview/production). */
  vercelEnvStage?: string;
  vercelEnvProd?: string;
  /** Split a variable shared across envs into a per-env record instead of updating all linked envs. */
  vercelPerEnvValues?: boolean;
  /**
   * Overrides for the mach repo topology (monorepo/workflow/repo naming),
   * populated by the discover-and-select dropdowns. Absent fields fall back to
   * blank until the org configures its own topology in Settings.
   */
  machRepo?: {
    apiBase?: string;
    monorepoOwner?: string;
    monorepoRepo?: string;
    monorepoRef?: string;
    workflowName?: string;
    destOwner?: string;
    repoTemplate?: string;
  };
  /** mach (backend) sync settings — drive the component-promotion workflow. */
  machBrand?: string;
  /** Source environment to promote from (e.g. test01). */
  machSourceEnv?: string;
  /** Branch of the source mach repo to read components.yml from. */
  machFromBranch?: string;
  /** Maps the release environment to a destination mach environment. */
  machEnvStage?: string;
  machEnvProd?: string;
  /** Also sync main.yml env vars when running the workflow. */
  machUpdateMainYml?: boolean;
  isConnectingGithub: boolean;
  isConnectingVercel: boolean;
  isTesting: boolean;
  testResults?: Record<string, DeploymentConnectionTest>;
  messageType: 'success' | 'error';
  statusMessage: string;
}

export interface EmbeddingProviderConfig {
  provider: 'local' | 'gemini';
  /** Primary key, kept in sync with apiKeys[0] for backward compat. */
  apiKey?: string;
  /** All configured keys, tried in order with failover on rate-limit (429). */
  apiKeys?: string[];
}

export interface VectorStoreConfig {
  location: 'local' | 'cloud';
  qdrantUrl?: string;
  qdrantApiKey?: string;
}

export interface WebSearchConfig {
  /** Primary key, kept in sync with apiKeys[0] for backward compat. */
  apiKey?: string;
  /** All configured Tavily keys, tried in order with failover on rate-limit (429). */
  apiKeys?: string[];
}

export interface AvailableModel {
  id: string;
}

export interface ModelConfig {
  selectedModel?: string;
  /** Optional stronger model for agent runs (autonomous / ticket-grounded); same provider and keys. */
  agentModel?: string;
  provider: string;
  /** Primary key, kept in sync with apiKeys[0] for backward compat. */
  apiKey?: string;
  /** All configured keys, tried in order with failover on rate-limit (429). */
  apiKeys?: string[];
  /** User-supplied base URL for the 'Custom' (OpenAI-compatible) provider. */
  baseUrl?: string;
  downloadProgress: number;
  downloadStatus: 'idle' | 'downloading' | 'completed' | 'error';
  errorMessage?: string;
  availableModels?: AvailableModel[];
  isLoadingModels?: boolean;
}
