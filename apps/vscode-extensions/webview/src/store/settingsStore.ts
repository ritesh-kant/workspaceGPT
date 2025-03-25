import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';

export interface ConfluenceConfig {
  baseUrl: string;
  spaceKey: string;
  userEmail: string;
  apiToken: string;
  isConfluenceEnabled: boolean;
  confluenceSyncProgress: number;
  confluenceIndexProgress: number;
  isSyncing: boolean;
  isIndexing: boolean;
  connectionStatus: 'unknown' | 'success' | 'error';
  statusMessage: string;
}

export interface CodebaseConfig {
  repoPath: string;
  scanFrequency: string;
  isSyncing: boolean;
  isIndexing: boolean;
  isCodebaseEnabled: boolean;
  codebaseSyncProgress: number;
  codebaseIndexProgress: number;
  connectionStatus: 'unknown' | 'success' | 'error';
  statusMessage: string;
}

export interface SettingsConfig {
  confluence: ConfluenceConfig;
  codebase: CodebaseConfig;
}

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
}

// Create a custom storage adapter for VSCode global state
import { STORAGE_KEYS } from '../constants';

const vscodeStorage = {
  getItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    return JSON.stringify(state[STORAGE_KEYS.SETTINGS] || {});
  },
  setItem: (_name: string, value: string) => {
    const vscode = VSCodeAPI();
    const currentState = vscode.getState() || {};
    vscode.setState({
      ...currentState,
      [STORAGE_KEYS.SETTINGS]: JSON.parse(value),
    });
    vscode.postMessage({
      type: 'syncGlobalState',
      state: JSON.parse(value),
    });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { [STORAGE_KEYS.SETTINGS]: settings, ...rest } = state;
    vscode.setState(rest);
    vscode.postMessage({
      type: 'clearGlobalState',
    });
  },
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      config: {
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
          connectionStatus: 'unknown',
          statusMessage: ''
        },
        codebase: {
          repoPath: '',
          scanFrequency: 'daily',
          isSyncing: false,
          isIndexing: false,
          isCodebaseEnabled: false,
          codebaseSyncProgress: 0,
          codebaseIndexProgress: 0,
          connectionStatus: 'unknown',
          statusMessage: ''
        },
      },
      showSettings: false,
      setConfig: (config) => set({ config }),
      updateConfig: (section, field, value) =>
        set((state) => {
          const newConfig = { ...state.config };
          (newConfig[section] as any)[field] = value;
          return { config: newConfig };
        }),
      setShowSettings: (showSettings) => set({ showSettings }),
    }),
    {
      name: 'workspaceGPT-settings-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);
