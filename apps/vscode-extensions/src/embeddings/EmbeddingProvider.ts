import { EmbeddingIdentity } from '../types/embeddingManifest';

/** Documents and queries get different task hints in the same vector space. */
export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  /** Identity written into the index manifest / checked at query time. */
  readonly identity: EmbeddingIdentity;

  /** Max texts the backend accepts per call (local ≈ memory-bound, Gemini = 100). */
  readonly maxBatchSize: number;

  /**
   * Embed a batch. Returns one vector per input, in order. `task` lets Gemini tag
   * RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY; local ignores it.
   */
  embedBatch(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

/** Convenience for the single-query path (chat). */
export async function embedOne(
  provider: EmbeddingProvider,
  text: string,
  task: EmbeddingTask,
): Promise<number[]> {
  const [vector] = await provider.embedBatch([text], task);
  return vector;
}
