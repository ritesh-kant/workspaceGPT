import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { STORAGE_KEYS } from '../../../constants';

export interface OllamaModel {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  digest: string;
  details: {
    parent_model: string;
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
}

export interface ModelConfig {
  selectedModel: string;
  isDownloading: boolean;
  downloadProgress: number;
  downloadStatus: 'idle' | 'downloading' | 'completed' | 'error';
  errorMessage?: string;
  downloadDetails?: {
    current: string;
    total: string;
  };
  availableModels?: OllamaModel[];
}

interface ModelState {
  config: ModelConfig;
  setConfig: (config: ModelConfig) => void;
  updateConfig: <K extends keyof ModelConfig>(
    field: K,
    value: ModelConfig[K]
  ) => void;
  batchUpdateConfig: (updates: Partial<ModelConfig>) => void;
  handleModelChange: (modelId: string) => void;
  resetStore: () => void;
}

// Create a custom storage adapter for VSCode global state
const vscodeStorage = {
  getItem: () => {
    const vscode = VSCodeAPI();
    // Request the latest settings from global state
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_GLOBAL_STATE,
      key: STORAGE_KEYS.MODEL,
    });
    return JSON.stringify({});
  },
  setItem: (_name: string, value: string) => {
    const vscode = VSCodeAPI();
    const currentState = vscode.getState() || {};
    vscode.setState({
      ...currentState,
      [STORAGE_KEYS.CHAT]: JSON.parse(value),
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_STATE,
      key: STORAGE_KEYS.MODEL,
      state: JSON.parse(value),
    });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { [STORAGE_KEYS.CHAT]: model, ...rest } = state;
    vscode.setState(rest);
    vscode.postMessage({
      type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
    });
  },
};

export const modelDefaultConfig: ModelConfig = {
  selectedModel: 'llama3.2:1b',
  isDownloading: false,
  downloadProgress: 0,
  downloadStatus: 'idle',
};

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      config: modelDefaultConfig,
      setConfig: (config) => set({ config }),
      updateConfig: (field, value) => {
        set((state) => ({
          config: {
            ...state.config,
            [field]: value,
          },
        }));
      },
      batchUpdateConfig: (updates) => {
        set((state) => ({
          config: {
            ...state.config,
            ...updates,
          },
        }));
      },
      handleModelChange: (modelId: string) => {
        set((state) => ({
          config: {
            ...state.config,
            selectedModel: modelId,
          },
        }));
      },
      resetStore: () => {
        const vscode = VSCodeAPI();
        vscode.setState({});
        vscode.postMessage({
          type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
        });
        set({ config: modelDefaultConfig });
      },
    }),
    {
      name: 'workspaceGPT-model-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);