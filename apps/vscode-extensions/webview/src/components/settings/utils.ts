import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import {
  useModelStore,
  useSettingsStore,
} from '../../store';
import { ModelConfig } from '../../types';

const vscode = VSCodeAPI();

export const clearStatusMessageAfterDelay = (
  section: 'confluence' | 'codebase',
  field: 'statusMessage' | 'messageType',
  value?: string | 'unknown',
  delay: number = 2000
) => {
  setTimeout(() => {
    const batchUpdateConfig = useSettingsStore.getState().batchUpdateConfig;
    batchUpdateConfig(section, {
      [field]: value,
    });
  }, delay);
};

export const handleConfluenceActions = {
  startOAuth: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CONFLUENCE_OAUTH,
    });
  },
 
  cancelOAuth: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.CANCEL_CONFLUENCE_OAUTH,
    });
  },

  disconnect: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.DISCONNECT_CONFLUENCE,
    });
  },

  fetchSpaces: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES,
    });
  },

  checkConnection: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION,
      section: 'confluence',
      config,
    });
  },

  startSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any, forceFull?: boolean) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
      forceFull,
    });
  },

  resumeSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  },

  stopSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  },
};

export const handleCodebaseActions = {
  startSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  },

  resumeSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  },

  resumeIndexing: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_INDEXING_CODEBASE,
      section: 'codebase',
      config,
    });
  },

  stopSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  },
};
export const handleInputChange = (
  section: 'confluence' | 'codebase',
  field: string,
  value: string
) => {
  const setConfig = useSettingsStore.getState().setConfig;
  const config = useSettingsStore.getState().config;
  const updatedConfig = {
    ...config,
    [section]: {
      ...config[section],
      [field]: value,
    },
  };
  setConfig(updatedConfig);
};

// Modified to accept providerName and apiKey
export const fetchAvailableModels = (
  providerName: string,
  apiKeyToUse?: string
) => {
  vscode.postMessage({
    type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS,
    provider: providerName,
    apiKey: apiKeyToUse,
  });
};
export function changeProviderHandler(provider: string) {
  const modelProviders = useModelStore.getState().modelProviders;
  const selectedModelProvider = modelProviders.find((p) => p.provider === provider);

  const { updateSelectedModelProvider, handleProviderChange } =
    useModelStore.getState().actions;

  const newModelProvider: ModelConfig = modelProviders.find(
    (p) => p.provider === provider
  )!;

  updateSelectedModelProvider(newModelProvider);

  handleProviderChange(newModelProvider.provider);
  if(!selectedModelProvider?.apiKey){
    return
  }
  fetchAvailableModels(provider, selectedModelProvider.apiKey);
}
