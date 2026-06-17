import { VectorStore } from './VectorStore';
import { QdrantVectorStore, QdrantConfig } from './QdrantVectorStore';

export type VectorStoreConfig =
  | { location: 'local' }
  | { location: 'cloud'; qdrant: QdrantConfig };

/**
 * Returns a cloud VectorStore (Qdrant) when selected, or null for local —
 * local search continues through the existing file-based path (embeddings.bin
 * + in-memory cosine in searchProcess). Callers treat null as "use local path".
 */
export function makeVectorStore(cfg: VectorStoreConfig): VectorStore | null {
  if (cfg.location === 'cloud') {
    if (!cfg.qdrant.url) throw new Error('Cloud vector store selected but no Qdrant URL configured.');
    return new QdrantVectorStore(cfg.qdrant);
  }
  return null;
}
