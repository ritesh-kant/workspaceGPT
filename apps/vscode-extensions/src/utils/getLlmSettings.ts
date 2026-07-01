import * as vscode from 'vscode';
import { MODEL_PROVIDERS, STORAGE_KEYS } from '../../constants';

export interface LlmSettings {
  provider?: string;
  model?: string;
  /** First configured key (kept for callers that only need one). */
  apiKey?: string;
  /** All configured keys, in failover order. Empty when none set. */
  apiKeys: string[];
  baseUrl?: string;
}

/**
 * Merge a legacy single key with the multi-key array into one ordered,
 * de-duplicated, blank-stripped list. Shared by both settings readers so the
 * failover order is consistent everywhere.
 */
export function normalizeApiKeys(apiKeys: unknown, legacy?: unknown): string[] {
  const arr = Array.isArray(apiKeys) ? apiKeys : [];
  const merged = [...arr, legacy].map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);
  return [...new Set(merged)];
}

/**
 * Read the currently selected chat model + key(s) from the persisted webview
 * model store (STORAGE_KEYS.MODEL). The base URL is resolved from
 * MODEL_PROVIDERS by provider name. Mirrors how ChatService builds its client.
 */
export function getLlmSettings(context: vscode.ExtensionContext): LlmSettings {
  const model = context.globalState.get(STORAGE_KEYS.MODEL) as any;
  const sel = model?.state?.selectedModelProvider;
  if (!sel) return { apiKeys: [] };
  const baseUrl = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === sel.provider)?.BASE_URL;
  const apiKeys = normalizeApiKeys(sel.apiKeys, sel.apiKey);
  return {
    provider: sel.provider,
    model: sel.selectedModel,
    apiKey: apiKeys[0] || undefined,
    apiKeys,
    baseUrl,
  };
}
