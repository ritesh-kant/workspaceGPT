import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { WorkspaceMode } from '../constants';


export interface SettingsConfig {
  /**
   * The single local/remote switch — see root `constants.ts` for the full
   * contract. Drives which settings sections render and which model the host
   * uses for inference; embedding/vectorStore provider fields below are
   * still stored here (keys, URLs) but their `provider`/`location`
   * discriminators are derived from `mode` on the host, not read from here.
   */
  mode: WorkspaceMode;
  /** Set once onboarding finishes (or is skipped past); gates the first-run flow. */
  onboardingCompleted: boolean;
  confluence: ConfluenceConfig;
  codebase: CodebaseConfig;
  ado: AdoConfig;
  deployment: DeploymentConfig;
  embedding: EmbeddingProviderConfig;
  vectorStore: VectorStoreConfig;
}

export const settingsDefaultConfig: SettingsConfig = {
  mode: 'local',
  onboardingCompleted: false,
  confluence: {
    isConfluenceEnabled: false,
    isAuthenticated: false,
    siteName: '',
    cloudId: '',
    spaceKey: '',
    availableSpaces: [],
    confluenceSyncProgress: 0,
    confluenceIndexProgress: 0,
    isSyncing: false,
    isIndexing: false,
    messageType: 'success',
    statusMessage: '',
    canResume: false,
    canResumeIndexing: false,
    isSyncCompleted: false,
    isIndexingCompleted: false,
    lastSyncTime: undefined,
    isConnecting: false,
  },
  ado: {
    isAdoEnabled: false,
    isAuthenticated: false,
    orgName: '',
    projectName: '',
    teamName: '',
    availableProjects: [],
    lookbackMonths: 24,
    userDisplayName: '',
    currentSprint: null,
    adoSyncProgress: 0,
    adoIndexProgress: 0,
    isSyncing: false,
    isIndexing: false,
    messageType: 'success',
    statusMessage: '',
    canResume: false,
    canResumeIndexing: false,
    isSyncCompleted: false,
    isIndexingCompleted: false,
    lastSyncTime: undefined,
    isConnecting: false,
  },
  codebase: {
    repoPath: '',
    scanFrequency: 'daily',
    includePatterns: '**/*.{js,ts,jsx,tsx,py,java,c,cpp,h,hpp}',
    excludePatterns: '**/node_modules/**,**/dist/**,**/.git/**',
    maxFileSizeKb: 500,
    isSyncing: false,
    isIndexing: false,
    isCodebaseEnabled: false,
    codebaseSyncProgress: 0,
    codebaseIndexProgress: 0,
    messageType: 'success',
    statusMessage: '',
    canResume: false,
    canResumeIndexing: false,
    isSyncCompleted: false,
    isIndexingCompleted: false
  },
  deployment: {
    isDeploymentEnabled: false,
    rosterPageUrl: '',
    vercelProjectId: '',
    vercelProjectName: '',
    vercelEnvStage: 'preview',
    vercelEnvProd: 'production',
    vercelPerEnvValues: false,
    machBrand: '',
    machSourceEnv: '',
    machFromBranch: 'main',
    machEnvStage: 'stage',
    machEnvProd: 'prod',
    machUpdateMainYml: true,
    githubConnected: false,
    vercelConnected: false,
    isConnectingGithub: false,
    isConnectingVercel: false,
    isTesting: false,
    messageType: 'success',
    statusMessage: '',
  },
  embedding: {
    provider: 'local',
    apiKey: '',
  },
  vectorStore: {
    location: 'local',
    qdrantUrl: '',
    qdrantApiKey: '',
  },
};

/** The object-valued sections of SettingsConfig — excludes the config-level
 *  scalars (`mode`, `onboardingCompleted`), which have their own dedicated
 *  setters below since `updateConfig`/`batchUpdateConfig` assume a section is
 *  spreadable. */
type SettingsSectionKey = Exclude<keyof SettingsConfig, 'mode' | 'onboardingCompleted'>;

interface SettingsState {
  config: SettingsConfig;
  setConfig: (config: SettingsConfig) => void;
  updateConfig: <T extends SettingsSectionKey, K extends keyof SettingsConfig[T]>(
    section: T,
    field: K,
    value: SettingsConfig[T][K]
  ) => void;
  batchUpdateConfig: <T extends SettingsSectionKey>(
    section: T,
    updates: Partial<SettingsConfig[T]>
  ) => void;
  /** Config-level scalars (not nested under a section, so `updateConfig` can't express them). */
  setMode: (mode: WorkspaceMode) => void;
  setOnboardingCompleted: (onboardingCompleted: boolean) => void;
  resetStore: () => void;
}

// Create a custom storage adapter for VSCode global state
import { MESSAGE_TYPES, STORAGE_KEYS } from '../constants';
import { CodebaseConfig, ConfluenceConfig, AdoConfig, DeploymentConfig, EmbeddingProviderConfig, VectorStoreConfig } from '../types';

const vscodeStorage = {
  getItem: () => {
    const vscode = VSCodeAPI();
    // Request the latest settings from global state
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_GLOBAL_STATE,
      key: STORAGE_KEYS.SETTINGS,
    });
    return JSON.stringify({});
  },
  setItem: (_name: string, value: string) => {
    const vscode = VSCodeAPI();
    const currentState = vscode.getState() || {};
    vscode.setState({
      ...currentState,
      [STORAGE_KEYS.SETTINGS]: JSON.parse(value),
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_STATE,
      key: STORAGE_KEYS.SETTINGS,
      state: JSON.parse(value),
    });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { [STORAGE_KEYS.SETTINGS]: settings, ...rest } = state;
    vscode.setState(rest);
    vscode.postMessage({
      type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
    });
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      config: settingsDefaultConfig,
      setConfig: (config) =>
        set({ config: { ...settingsDefaultConfig, ...config } }),
      updateConfig: (section, field, value) => {
        set((state) => {
          const newConfig = { ...state.config };
          // Add type checking and logging
          console.log(`Updating ${section}.${String(field)} to:`, value);
          if (section in newConfig) {
            (newConfig[section] as any)[field] = value;
          } else {
            console.warn(`Invalid update attempt: ${section}.${String(field)}`);
          }
          return { config: newConfig };
        });
      },
      batchUpdateConfig: (section, updates) => {
        set((state) => {
          const newConfig = { ...state.config };
          newConfig[section] = {
            ...newConfig[section],
            ...updates
          };
          return { config: newConfig };
        });
      },
      setMode: (mode) => set((state) => ({ config: { ...state.config, mode } })),
      setOnboardingCompleted: (onboardingCompleted) =>
        set((state) => ({ config: { ...state.config, onboardingCompleted } })),
      resetStore: () => {
        const vscode = VSCodeAPI();
        vscode.setState({});
        vscode.postMessage({
          type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
        });
        set({ config: settingsDefaultConfig });
        vscode.postMessage({
          type: MESSAGE_TYPES.GET_WORKSPACE_PATH,
        });
      },
    }),
    {
      name: 'workspaceGPT-settings-storage',
      storage: createJSONStorage(() => vscodeStorage),
      // Merge persisted state over defaults so new config sections (e.g. embedding)
      // always exist even when older stored settings omit them.
      merge: (persisted: any, current) => ({
        ...current,
        ...(persisted ?? {}),
        config: {
          ...settingsDefaultConfig,
          ...((persisted as any)?.config ?? {}),
        },
      }),
    }
  )
);
