export interface SettingsButtonProps {
  isVisible: boolean;
  onBack: () => void;
}

export interface StatusMessage {
  section: 'confluence' | 'codebase';
  field: 'statusMessage' | 'messageType';
  value: string | 'unknown';
  delay?: number;
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

export interface CodebaseConfig {
  repoPath: string;
  scanFrequency: string;
  includePatterns: string;
  excludePatterns: string;
  maxFileSizeKb: number;
  isSyncing: boolean;
  isIndexing: boolean;
  isCodebaseEnabled: boolean;
  codebaseSyncProgress: number;
  codebaseIndexProgress: number;
  messageType: 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
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

export interface DeploymentConnectionTest {
  ok: boolean;
  detail?: string;
}

export interface DeploymentConfig {
  isDeploymentEnabled?: boolean;
  /** Confluence Release Roster page URL — source for resolving today's release. */
  rosterPageUrl?: string;
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
  apiKey?: string;
}

export interface VectorStoreConfig {
  location: 'local' | 'cloud';
  qdrantUrl?: string;
  qdrantApiKey?: string;
}

export interface AvailableModel {
  id: string;
}

export interface ModelConfig {
  selectedModel?: string;
  provider: string;
  apiKey?: string;
  downloadProgress: number;
  downloadStatus: 'idle' | 'downloading' | 'completed' | 'error';
  errorMessage?: string;
  availableModels?: AvailableModel[];
  isLoadingModels?: boolean;
}