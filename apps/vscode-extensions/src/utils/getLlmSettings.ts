import * as vscode from 'vscode';
import { MODEL_PROVIDERS, REMOTE_INFERENCE_BASE_URL, REMOTE_MODEL, STORAGE_KEYS } from '../../constants';
import { getCachedRemoteSessionToken } from '../services/remote/remoteSessionCache';
import { getMode } from './getModeSettings';

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
 * Read the LLM to use for chat inference.
 *
 * `local` mode is unchanged: the currently selected chat model + key(s) from
 * the persisted webview model store, base URL resolved from MODEL_PROVIDERS.
 *
 * `remote` mode is managed inference. There is no model picker and no provider
 * key: the base URL is the WorkspaceGPT Worker and the "API key" is the user's
 * session token, which the Worker validates on every request before proxying
 * to OpenRouter on the vendor's key. The model id is symbolic — the Worker
 * substitutes the real one — so the managed model can change without an
 * extension release. Returns no key when signed out, which every caller
 * already treats as "not configured".
 */
export function getLlmSettings(context: vscode.ExtensionContext): LlmSettings {
  if (getMode(context) === 'remote') {
    const sessionToken = getCachedRemoteSessionToken();
    return {
      provider: REMOTE_MODEL.PROVIDER,
      model: REMOTE_MODEL.ID,
      apiKey: sessionToken,
      apiKeys: sessionToken ? [sessionToken] : [],
      baseUrl: REMOTE_INFERENCE_BASE_URL,
    };
  }

  const model = context.globalState.get(STORAGE_KEYS.MODEL) as any;
  const sel = model?.state?.selectedModelProvider;
  if (!sel) return { apiKeys: [] };
  // 'Custom' (and any future user-configurable provider) stores its own base
  // URL per-config; that always wins over the static per-provider table.
  const baseUrl =
    sel.baseUrl || MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === sel.provider)?.BASE_URL;
  const apiKeys = normalizeApiKeys(sel.apiKeys, sel.apiKey);
  return {
    provider: sel.provider,
    model: sel.selectedModel,
    apiKey: apiKeys[0] || undefined,
    apiKeys,
    baseUrl,
  };
}
