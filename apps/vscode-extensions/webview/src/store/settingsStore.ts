import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';

export interface ConfluenceConfig {
  baseUrl: string;
  spaceKey: string;
  userEmail: string;
  apiToken: string;
}

export interface CodebaseConfig {
  repoPath: string;
  scanFrequency: string;
}

export interface SettingsConfig {
  confluence: ConfluenceConfig;
  codebase: CodebaseConfig;
}

interface SettingsState {
  config: SettingsConfig;
  isConfluenceEnabled: boolean;
  isCodebaseEnabled: boolean;
  isConfluenceSyncing: boolean;
  isCodebaseSyncing: boolean;
  confluenceSyncProgress: number;
  codebaseSyncProgress: number;
  connectionStatus: 'unknown' | 'success' | 'error';
  statusMessage: string;
  showSettings: boolean;
  setConfig: (config: SettingsConfig) => void;
  updateConfig: (field: keyof SettingsConfig, value: string) => void;
  setIsConfluenceEnabled: (enabled: boolean) => void;
  setIsCodebaseEnabled: (enabled: boolean) => void;
  setIsConfluenceSyncing: (syncing: boolean) => void;
  setIsCodebaseSyncing: (syncing: boolean) => void;
  setConfluenceSyncProgress: (progress: number) => void;
  setCodebaseSyncProgress: (progress: number) => void;
  setConnectionStatus: (status: 'unknown' | 'success' | 'error') => void;
  setStatusMessage: (message: string) => void;
  setShowSettings: (show: boolean) => void;
}

// Create a custom storage adapter for VSCode
const vscodeStorage = {
  getItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    return JSON.stringify(state.settings || {});
  },
  setItem: (_name: string, value: string) => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    vscode.setState({ ...state, settings: JSON.parse(value) });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { settings, ...rest } = state;
    vscode.setState(rest);
  }
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      config: {
        confluence: {
          baseUrl: '',
          spaceKey: '',
          userEmail: '',
          apiToken: ''
        },
        codebase: {
          repoPath: '',
          scanFrequency: 'daily'
        }
      },
      isConfluenceEnabled: false,
      isCodebaseEnabled: false,
      isConfluenceSyncing: false,
      isCodebaseSyncing: false,
      confluenceSyncProgress: 0,
      codebaseSyncProgress: 0,
      connectionStatus: 'unknown',
      statusMessage: '',
      showSettings: false,
      setConfig: (config) => set({ config }),
      updateConfig: (field: keyof SettingsConfig | keyof ConfluenceConfig | keyof CodebaseConfig, value: string) =>
        set((state) => {
          const newConfig = { ...state.config };
          if (field in newConfig.confluence) {
            newConfig.confluence = { ...newConfig.confluence, [field]: value };
          } else if (field in newConfig.codebase) {
            newConfig.codebase = { ...newConfig.codebase, [field]: value };
          }
          return { config: newConfig };
        }),
      setIsConfluenceEnabled: (isConfluenceEnabled) => set({ isConfluenceEnabled }),
      setIsCodebaseEnabled: (isCodebaseEnabled) => set({ isCodebaseEnabled }),
      setIsConfluenceSyncing: (isConfluenceSyncing) => set({ isConfluenceSyncing }),
      setIsCodebaseSyncing: (isCodebaseSyncing) => set({ isCodebaseSyncing }),
      setConfluenceSyncProgress: (confluenceSyncProgress) => set({ confluenceSyncProgress }),
      setCodebaseSyncProgress: (codebaseSyncProgress) => set({ codebaseSyncProgress }),
      setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
      setStatusMessage: (statusMessage) => set({ statusMessage }),
      setShowSettings: (showSettings) => set({ showSettings })
    }),
    {
      name: 'workspaceGPT-settings-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);