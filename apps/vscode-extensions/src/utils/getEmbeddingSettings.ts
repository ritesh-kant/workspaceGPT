import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { EmbeddingProviderId } from '../types/embeddingManifest';

export interface EmbeddingSettings {
  provider: EmbeddingProviderId;
  apiKey?: string;
}

/**
 * Read the embedding provider + key from the persisted webview settings store.
 * Defaults to local so existing installs (no `embedding` section) keep working.
 */
export function getEmbeddingSettings(
  context: vscode.ExtensionContext,
): EmbeddingSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const emb = settings?.state?.config?.embedding;
  return {
    provider: emb?.provider === 'gemini' ? 'gemini' : 'local',
    apiKey: emb?.apiKey || undefined,
  };
}
