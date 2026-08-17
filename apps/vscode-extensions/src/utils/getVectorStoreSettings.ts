import * as vscode from 'vscode';
import { STORAGE_KEYS, normalizeQdrantUrl } from '../../constants';
import { getMode } from './getModeSettings';

export interface VectorStoreSettings {
  location: 'local' | 'cloud';
  qdrantUrl?: string;
  qdrantApiKey?: string;
}

/**
 * Read the vector-store location + Qdrant connection from the persisted
 * webview settings. The location is derived from {@link getMode} (not the
 * stored discriminator) so it can never disagree with the active mode.
 */
export function getVectorStoreSettings(
  context: vscode.ExtensionContext,
): VectorStoreSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const vs = settings?.state?.config?.vectorStore;
  return {
    location: getMode(context) === 'remote' ? 'cloud' : 'local',
    // Normalize defensively so a bare Qdrant Cloud URL (missing :6333) still
    // reaches the REST API regardless of what's persisted in settings.
    qdrantUrl: vs?.qdrantUrl ? normalizeQdrantUrl(vs.qdrantUrl) : undefined,
    qdrantApiKey: vs?.qdrantApiKey || undefined,
  };
}
