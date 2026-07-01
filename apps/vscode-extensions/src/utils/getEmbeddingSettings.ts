import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { EmbeddingProviderId } from '../types/embeddingManifest';
import { normalizeApiKeys } from './getLlmSettings';

export interface EmbeddingSettings {
  provider: EmbeddingProviderId;
  /** First configured key (kept for callers that only need one). */
  apiKey?: string;
  /** All configured keys, in failover order. Empty when none set. */
  apiKeys: string[];
}

/**
 * Read the embedding provider + key(s) from the persisted webview settings
 * store. Defaults to local so existing installs (no `embedding` section) keep
 * working.
 */
export function getEmbeddingSettings(
  context: vscode.ExtensionContext,
): EmbeddingSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const emb = settings?.state?.config?.embedding;
  const apiKeys = normalizeApiKeys(emb?.apiKeys, emb?.apiKey);
  return {
    provider: emb?.provider === 'gemini' ? 'gemini' : 'local',
    apiKey: apiKeys[0] || undefined,
    apiKeys,
  };
}
