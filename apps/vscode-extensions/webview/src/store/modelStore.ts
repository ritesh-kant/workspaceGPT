import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { MODEL, MODEL_PROVIDERS, STORAGE_KEYS } from '../../../constants';

export interface AvailableModel {
  id: string;
}

export interface ModelConfig {
  selectedModel: string;
  provider: string;
  apiKey?: string;
  isDownloading: boolean;
  downloadProgress: number;
  downloadStatus: 'idle' | 'downloading' | 'completed' | 'error';
  errorMessage?: string;
  availableModels?: AvailableModel[];
  isLoadingModels?: boolean;
}

export interface SelectedProviderType {
  provider: string;
  providerIndex: number;
}

interface ModelState {
  modelProviders: ModelConfig[];
  selectedModelProvider: SelectedProviderType;
  actions: {
    updateSelectedModelProvider: (
      selectedModelProvider: SelectedProviderType
    ) => void; // Add this line
    updateModelProvider: <K extends keyof ModelConfig>(
      providerIndex: number, // Assuming we need to specify which provider to update
      field: K,
      value: ModelConfig[K]
    ) => void;
    batchUpdateModelProvider: (
      providerIndex: number,
      updates: Partial<ModelConfig>
    ) => void; // Assuming we need to specify which provider to update

    handleModelChange: (providerIndex: number, modelId: string) => void; // Assuming we need to specify which provider to update
    handleProviderChange: (providerIndex: number, provider: string) => void; // Assuming we need to specify which provider to update
    resetStore: () => void;
  };
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
      [STORAGE_KEYS.MODEL]: JSON.parse(value),
    });
    console.log(
      '===========updateing global state with model data',
      value,
      '============'
    );
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_GLOBAL_STATE,
      key: STORAGE_KEYS.MODEL,
      state: JSON.parse(value),
    });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { [STORAGE_KEYS.MODEL]: model, ...rest } = state;
    vscode.setState(rest);
    vscode.postMessage({
      type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
    });
  },
};

export const modelDefaultConfig: ModelConfig[] = MODEL_PROVIDERS.map(
  (provider) => ({
    provider: provider.MODEL_PROVIDER,
    selectedModel: provider.DEFAULT_CHAT_MODEL,
    apiKey: provider.API_KEY,
    isDownloading: false,
    downloadProgress: 0,
    downloadStatus: 'idle',
    isLoadingModels: false,
    availableModels: [],
  })
);

const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      modelProviders: modelDefaultConfig, // Initialize with the array
      selectedModelProvider: { provider: MODEL.OLLAMA, providerIndex: 0 }, // Initialize as an object
      actions: {
        updateSelectedModelProvider: (
          selectedModelProvider: SelectedProviderType
        ) => set({ selectedModelProvider }), // Update to take SelectedProviderType
        updateModelProvider: (providerIndex, field, value) => {
          console.log('updating field', field, value);
          set((state) => ({
            modelProviders: state.modelProviders.map((config, index) =>
              index === providerIndex ? { ...config, [field]: value } : config
            ),
          }));
        },
        batchUpdateModelProvider: (providerIndex, updates) => {
          set((state) => ({
            modelProviders: state.modelProviders.map((config, index) =>
              index === providerIndex ? { ...config, ...updates } : config
            ),
          }));
        },
        handleModelChange: (providerIndex, modelId: string) => {
          set((state) => ({
            modelProviders: state.modelProviders.map((config, index) =>
              index === providerIndex
                ? { ...config, selectedModel: modelId }
                : config
            ),
          }));
        },
        handleProviderChange: (providerIndex, provider: string) => {
          console.log(
            'setting new provider for index',
            providerIndex,
            provider
          );
          set((state) => ({
            modelProviders: state.modelProviders.map((config, index) =>
              index === providerIndex
                ? {
                    ...config,
                    provider,
                  }
                : config
            ),
          }));
        },
        resetStore: () => {
          const vscode = VSCodeAPI();
          vscode.setState({});
          vscode.postMessage({
            type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
          });
          set({ modelProviders: modelDefaultConfig }); // Use the array here
        },
      },
    }),
    {
      name: 'workspaceGPT-model-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);

// custom hooks for model store

export const setModelState = (newState: ModelState) => {
  useModelStore.setState((state) => ({ ...newState, actions: state.actions }));
};

export const useModelProviders = () =>
  useModelStore((state) => state.modelProviders);

export const useSelectedModelProvider = () =>
  useModelStore((state) => state.selectedModelProvider);

export const useModelActions = () => useModelStore((state) => state.actions);
