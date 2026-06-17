import * as vscode from 'vscode';
import { MODEL_PROVIDERS, STORAGE_KEYS } from '../../constants';

export interface LlmSettings {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Read the currently selected chat model + key from the persisted webview model
 * store (STORAGE_KEYS.MODEL). The base URL is resolved from MODEL_PROVIDERS by
 * provider name. Mirrors how ChatService builds its OpenAI client.
 */
export function getLlmSettings(context: vscode.ExtensionContext): LlmSettings {
  const model = context.globalState.get(STORAGE_KEYS.MODEL) as any;
  const sel = model?.state?.selectedModelProvider;
  if (!sel) return {};
  const baseUrl = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === sel.provider)?.BASE_URL;
  return {
    provider: sel.provider,
    model: sel.selectedModel,
    apiKey: sel.apiKey || undefined,
    baseUrl,
  };
}
