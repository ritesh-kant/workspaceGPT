import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';


export interface SettingsConfig {
  confluence: ConfluenceConfig;
  codebase: CodebaseConfig;
}

export const settingsDefaultConfig: SettingsConfig = {
  confluence: {
    baseUrl: '',
    spaceKey: '',
    userEmail: '',
    apiToken: '',
    isConfluenceEnabled: false,
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
    lastSyncTime: undefined
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
};

interface SettingsState {
  config: SettingsConfig;
  showSettings: boolean;
  setConfig: (config: SettingsConfig) => void;
  updateConfig: <T extends keyof SettingsConfig, K extends keyof SettingsConfig[T]>(
    section: T,
    field: K,
    value: SettingsConfig[T][K]
  ) => void;
  setShowSettings: (show: boolean) => void;
  batchUpdateConfig: <T extends keyof SettingsConfig>(
    section: T,
    updates: Partial<SettingsConfig[T]>
  ) => void;
  resetStore: () => void;
}

// Create a custom storage adapter for VSCode global state
import { MESSAGE_TYPES, STORAGE_KEYS } from '../constants';
import { CodebaseConfig, ConfluenceConfig } from '../types';

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
      showSettings: false,
      setConfig: (config) => set({ config }),
      updateConfig: (section, field, value) => {
        set((state) => {
          const newConfig = { ...state.config };
          // Add type checking and logging
          console.log(`Updating ${section}.${String(field)} to:`, value);
          if (section in newConfig && field in newConfig[section]) {
            (newConfig[section] as any)[field] = value;
          } else {
            console.warn(`Invalid update attempt: ${section}.${String(field)}`);
          }
          return { config: newConfig };
        });
      },
      setShowSettings: (showSettings) => set({ showSettings }),
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
      resetStore: () => {
        const vscode = VSCodeAPI();
        vscode.setState({});
        vscode.postMessage({
          type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
        });
        set({ config: settingsDefaultConfig, showSettings: false });
        vscode.postMessage({
          type: MESSAGE_TYPES.GET_WORKSPACE_PATH,
        });
      },
    }),
    {
      name: 'workspaceGPT-settings-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);
