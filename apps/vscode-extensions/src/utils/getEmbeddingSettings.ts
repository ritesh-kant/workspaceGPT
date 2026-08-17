import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { EmbeddingProviderId } from '../types/embeddingManifest';
import { normalizeApiKeys } from './getLlmSettings';
import { getMode } from './getModeSettings';

export interface EmbeddingSettings {
  provider: EmbeddingProviderId;
  /** First configured key (kept for callers that only need one). */
  apiKey?: string;
  /** All configured keys, in failover order. Empty when none set. */
  apiKeys: string[];
}

/**
 * Read the embedding provider + key(s) from the persisted webview settings
 * store. The provider is derived from {@link getMode} (not the stored
 * discriminator) so it can never disagree with the active mode — remote is
 * always Gemini, local is always the bundled model. Keys are still read from
 * their stored fields.
 */
export function getEmbeddingSettings(
  context: vscode.ExtensionContext,
): EmbeddingSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const emb = settings?.state?.config?.embedding;
  const apiKeys = normalizeApiKeys(emb?.apiKeys, emb?.apiKey);
  return {
    provider: getMode(context) === 'remote' ? 'gemini' : 'local',
    apiKey: apiKeys[0] || undefined,
    apiKeys,
  };
}
