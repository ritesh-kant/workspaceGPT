import * as vscode from 'vscode';
import { LlmTask, MODEL_PROVIDERS, REMOTE_TASK_MODELS, STORAGE_KEYS } from '../../constants';
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
 * Keys for a routed remote-mode provider. Gemini resolves to the same keys the
 * user enters for embeddings (`config.embedding.apiKeys`) — there is only one
 * Gemini key surface in remote mode. Any other provider named in
 * {@link REMOTE_TASK_MODELS} falls back to whatever that provider has stored
 * in the model blob, so routing entries can move to a different provider
 * later without new UI: if the owner adds keys for it there, they resolve.
 */
function remoteKeysForProvider(context: vscode.ExtensionContext, provider: string): string[] {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  if (provider === 'Gemini') {
    const emb = settings?.state?.config?.embedding;
    return normalizeApiKeys(emb?.apiKeys, emb?.apiKey);
  }
  const model = context.globalState.get(STORAGE_KEYS.MODEL) as any;
  const sel = model?.state?.selectedModelProvider;
  if (sel?.provider === provider) {
    return normalizeApiKeys(sel.apiKeys, sel.apiKey);
  }
  return [];
}

/**
 * Read the LLM to use for a given inference task. In `local` mode this is
 * unchanged: the currently selected chat model + key(s) from the persisted
 * webview model store (STORAGE_KEYS.MODEL), with the base URL resolved from
 * MODEL_PROVIDERS by provider name. In `remote` mode the model picker is
 * hidden entirely — the task is routed via {@link REMOTE_TASK_MODELS} (owner-
 * editable in code) and its keys resolved via {@link remoteKeysForProvider}.
 * `task` defaults to `'chat'` so existing single-purpose callers (share-to-
 * chrome validation, deployment AI helpers) keep working unchanged.
 */
export function getLlmSettings(
  context: vscode.ExtensionContext,
  task: LlmTask = 'chat',
): LlmSettings {
  if (getMode(context) === 'remote') {
    const route = REMOTE_TASK_MODELS[task];
    const baseUrl = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === route.provider)?.BASE_URL;
    const apiKeys = remoteKeysForProvider(context, route.provider);
    return {
      provider: route.provider,
      model: route.model,
      apiKey: apiKeys[0] || undefined,
      apiKeys,
      baseUrl,
    };
  }

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
