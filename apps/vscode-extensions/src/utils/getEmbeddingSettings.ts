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
 * store.
 *
 * The provider is always `local` (the bundled ONNX model), in both workspace
 * modes. Indexing is deliberately not part of the local/remote switch: remote
 * mode sells managed *inference*, and forcing a mode switch to also move
 * embeddings to a cloud provider would make the user supply a Gemini key for
 * the privilege of not needing model keys. Any stored `apiKeys` are still
 * returned so a cloud embedding provider can be re-enabled later (and so the
 * legacy-mode inference in getModeSettings can still read them).
 */
export function getEmbeddingSettings(
  context: vscode.ExtensionContext,
): EmbeddingSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const emb = settings?.state?.config?.embedding;
  const apiKeys = normalizeApiKeys(emb?.apiKeys, emb?.apiKey);
  return {
    provider: 'local',
    apiKey: apiKeys[0] || undefined,
    apiKeys,
  };
}
