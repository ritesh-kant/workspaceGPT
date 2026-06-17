import { EmbeddingIdentity } from './embeddingManifest';

export type EmbeddingTask = 'document' | 'query';

export interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;
  readonly maxBatchSize: number;
  embedBatch(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

export async function embedOne(
  provider: EmbeddingProvider,
  text: string,
  task: EmbeddingTask,
): Promise<number[]> {
  const [vector] = await provider.embedBatch([text], task);
  return vector;
}
