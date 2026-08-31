import * as vscode from 'vscode';
import { STORAGE_KEYS, normalizeQdrantUrl } from '../../constants';

export interface VectorStoreSettings {
  location: 'local' | 'cloud';
  qdrantUrl?: string;
  qdrantApiKey?: string;
}

/**
 * Read the vector-store location + Qdrant connection from the persisted
 * webview settings.
 *
 * The location is always `local` (the on-disk file store), in both workspace
 * modes — same reasoning as getEmbeddingSettings: the local/remote switch
 * moves inference, never the index. The Qdrant fields are still read so the
 * cloud path can be re-enabled later without a settings migration.
 */
export function getVectorStoreSettings(
  context: vscode.ExtensionContext,
): VectorStoreSettings {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const vs = settings?.state?.config?.vectorStore;
  return {
    location: 'local',
    // Normalize defensively so a bare Qdrant Cloud URL (missing :6333) still
    // reaches the REST API regardless of what's persisted in settings.
    qdrantUrl: vs?.qdrantUrl ? normalizeQdrantUrl(vs.qdrantUrl) : undefined,
    qdrantApiKey: vs?.qdrantApiKey || undefined,
  };
}
