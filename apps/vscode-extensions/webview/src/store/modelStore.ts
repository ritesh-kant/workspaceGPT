import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { MODEL } from '../../../constants';

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
}

// Create a custom storage adapter for VSCode global state
const vscodeStorage = {
  getItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    return JSON.stringify(state[MODEL.DEFAULT_MODEL] || {});
  },
  setItem: (_name: string, value: string) => {
    const vscode = VSCodeAPI();
    const currentState = vscode.getState() || {};
    vscode.setState({
      ...currentState,
      [MODEL.DEFAULT_MODEL]: JSON.parse(value),
    });
    vscode.postMessage({
      type: MESSAGE_TYPES.SYNC_GLOBAL_STATE,
      state: JSON.parse(value),
    });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { [MODEL.DEFAULT_MODEL]: model, ...rest } = state;
    vscode.setState(rest);
    vscode.postMessage({
      type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
    });
  },
};

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      config: {
        selectedModel: 'llama3.2:1b',
        isDownloading: false,
        downloadProgress: 0,
        downloadStatus: 'idle',
      },
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
    }),
    {
      name: 'workspaceGPT-model-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);