import * as vscode from 'vscode';
import { STORAGE_KEYS, normalizeQdrantUrl } from '../../constants';

export interface VectorStoreSettings {
  location: 'local' | 'cloud';
  qdrantUrl?: string;
  qdrantApiKey?: string;
}

/**
 * Read the vector-store location + Qdrant connection from the persisted webview
 * settings. Defaults to local so existing installs keep their file-based index.
 */
export function getVectorStoreSettings(
  context: vscode.ExtensionContext,
): VectorStoreSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const vs = settings?.state?.config?.vectorStore;
  return {
    location: vs?.location === 'cloud' ? 'cloud' : 'local',
    // Normalize defensively so a bare Qdrant Cloud URL (missing :6333) still
    // reaches the REST API regardless of what's persisted in settings.
    qdrantUrl: vs?.qdrantUrl ? normalizeQdrantUrl(vs.qdrantUrl) : undefined,
    qdrantApiKey: vs?.qdrantApiKey || undefined,
  };
}
