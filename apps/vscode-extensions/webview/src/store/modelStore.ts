import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { MODEL_PROVIDERS, STORAGE_KEYS } from '../../../constants';
import { ModelConfig } from '../types';

interface ModelState {
  modelProviders: ModelConfig[];
  selectedModelProvider: ModelConfig;
  actions: {
    updateSelectedModelProvider: (
      selectedModelProvider: ModelConfig
    ) => void; // Add this line
    updateModelProvider: <K extends keyof ModelConfig>(
      providerId: string, 
      field: K,
      value: ModelConfig[K]
    ) => void;
    batchUpdateModelProvider: (
      providerIndex: number,
      updates: Partial<ModelConfig>
    ) => void; 

    handleModelChange: (modelId: string, providerId: string) => void; // Assuming we need to specify which provider to update
    handleProviderChange: (providerId: string) => void; // Assuming we need to specify which provider to update
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

export const useModelStore = create<ModelState>()(
  persist(
    (set) => ({
      modelProviders: modelDefaultConfig, // Initialize with the array
      selectedModelProvider: modelDefaultConfig[0], // Initialize as an object
      actions: {
        updateSelectedModelProvider: (
          selectedModelProvider: ModelConfig
        ) => set({ selectedModelProvider }), // Update to take ModelConfig
        updateModelProvider: (providerId, field, value) => {
          console.log('updating field', field, value);
          set((state) => ({
            modelProviders: state.modelProviders.map((config) =>
              config.provider === providerId ? { ...config, [field]: value } : config
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
        handleModelChange: (modelId: string, providerId: string) => {
          set((state) => {
            const updatedModelProviders = state.modelProviders.map((config) =>
              config.provider === providerId
                ? { ...config, selectedModel: modelId }
                : config
            );

            const newSelectedProviderConfig = updatedModelProviders.find(
              (config) => config.provider === providerId
            );

            return {
              modelProviders: updatedModelProviders,
              selectedModelProvider: newSelectedProviderConfig || state.selectedModelProvider,
            };
          });
        },
        handleProviderChange: ( providerId: string) => {
       
          set((state) => ({
            modelProviders: state.modelProviders.map((config) =>
              config.provider === providerId
                ? {
                    ...config,
                    provider:providerId,
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
          set({ 
            modelProviders: modelDefaultConfig,
            selectedModelProvider: modelDefaultConfig[0] 
          }); 
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
