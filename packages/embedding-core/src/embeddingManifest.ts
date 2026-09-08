// Identity + manifest types shared by the embedding pipeline (VS Code + Chrome).
// The `embedding` block is the compatibility contract: corpus and query MUST agree
// on it or cosine search returns garbage (see embeddingCompat.ts).

export type EmbeddingProviderId = 'local' | 'gemini';

/** The identity an index must share with whoever queries it. */
export interface EmbeddingIdentity {
  provider: EmbeddingProviderId;
  model: string; // 'Xenova/all-MiniLM-L6-v2' | 'gemini-embedding-001'
  dimensions: number; // 384 (local) | 768 (gemini, MRL-truncated)
  normalized: boolean; // cosine on normalized vs raw vectors drifts — must match
}

/** Written to index.json next to embeddings.bin. */
export interface EmbeddingIndexManifest {
  schemaVersion: 1;
  embedding: EmbeddingIdentity;
  /**
   * Gemini tags the corpus RETRIEVAL_DOCUMENT and queries RETRIEVAL_QUERY — same
   * model/space, different hint. Recorded for provenance; the compat check ignores it.
   */
  docTaskType?: string;
  source: 'CONFLUENCE' | 'ADO';
  count: number;
  builtAt: string; // ISO 8601
  builtBy: string; // who produced it, e.g. 'vscode-extension'
  shareable: boolean; // true only when provider === 'gemini'

  // ── legacy fields kept for back-compat with existing index.json readers ──
  total: number;
  dimensions: number;
  includesMetadata: boolean;
  metadataFields: string[];
}
