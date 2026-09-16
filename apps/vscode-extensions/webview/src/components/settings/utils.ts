import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import {
  useModelStore,
  useSettingsStore,
} from '../../store';
import { ModelConfig } from '../../types';

const vscode = VSCodeAPI();

export { clearStatusMessageAfterDelay } from '../../store/statusMessage';

/**
 * Compact "how long ago" for collapsed section summaries, where an absolute
 * timestamp is both too long and more precision than the question needs. The
 * expanded section still shows the full local timestamp.
 */
export function formatRelativeTime(iso?: string): string {
  if (!iso) return 'never synced';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never synced';

  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;
  return `synced ${Math.round(hours / 24)}d ago`;
}

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
};

// Check/start/resume/stop for both Confluence and ADO now live in
// SyncControls' useSyncActions — they were byte-for-byte identical apart from
// the message type, and the two copies had already drifted.

export const handleAdoActions = {

  disconnect: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.DISCONNECT_ADO,
    });
  },
};

export const handleJiraActions = {
  startOAuth: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.START_JIRA_OAUTH,
    });
  },

  cancelOAuth: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.CANCEL_JIRA_OAUTH,
    });
  },

  disconnect: (vscode: ReturnType<typeof VSCodeAPI>) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.DISCONNECT_JIRA,
    });
  },
};

export const handleInputChange = (
  section: 'confluence' | 'ado' | 'jira',
  field: string,
  value: string | number
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
  apiKeyToUse?: string,
  baseUrl?: string
) => {
  vscode.postMessage({
    type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS,
    provider: providerName,
    apiKey: apiKeyToUse,
    baseUrl,
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
  fetchAvailableModels(provider, selectedModelProvider.apiKey, selectedModelProvider.baseUrl);
}
