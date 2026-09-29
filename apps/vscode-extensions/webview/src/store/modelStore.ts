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
    /** Settings → Model → Effort and the composer's effort picker; undefined = the provider decides. */
    setReasoningEffort: (effort?: string) => void;
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
        setReasoningEffort: (effort) => {
          set((state) => ({
            modelProviders: state.modelProviders.map((config) =>
              config.provider === state.selectedModelProvider.provider ? { ...config, reasoningEffort: effort } : config
            ),
            selectedModelProvider: { ...state.selectedModelProvider, reasoningEffort: effort },
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
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Merge any new providers that were added to MODEL_PROVIDERS
        // but don't yet exist in the persisted modelProviders array.
        const existingProviderNames = new Set(
          state.modelProviders.map((p) => p.provider)
        );
        const newProviders = modelDefaultConfig.filter(
          (p) => !existingProviderNames.has(p.provider)
        );
        if (newProviders.length > 0) {
          useModelStore.setState({
            modelProviders: [...state.modelProviders, ...newProviders],
          });
        }
      },
    }
  )
);

/**
 * The effort levels to offer for this provider and model. 'per-model'
 * providers (GitHub Copilot, OpenRouter) say which models take an effort, so
 * it is the levels the chat or agent-run model declares, in declared order;
 * OpenAI and Gemini don't, so it is their provider-wide levels. Empty — and
 * no picker — for every provider the worker doesn't send an effort to.
 */
export const effortLevelsFor = (config: ModelConfig): string[] => {
  const supported = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === config.provider)?.REASONING_EFFORT;
  if (Array.isArray(supported)) return supported;
  if (supported !== 'per-model') return [];
  return [
    ...new Set(
      [config.selectedModel, config.agentModel].flatMap(
        (id) => config.availableModels?.find((m) => m.id === id)?.reasoningEfforts ?? []
      )
    ),
  ];
};

/** 'high' → 'High' for display; the stored value stays what the provider declared. */
export const effortLabel = (level: string): string => level.charAt(0).toUpperCase() + level.slice(1);

// custom hooks for model store

export const setModelState = (newState: ModelState) => {
  useModelStore.setState((state) => ({ ...newState, actions: state.actions }));
};

export const useModelProviders = () =>
  useModelStore((state) => state.modelProviders);

export const useSelectedModelProvider = () =>
  useModelStore((state) => state.selectedModelProvider);

export const useModelActions = () => useModelStore((state) => state.actions);
