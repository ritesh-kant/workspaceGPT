import { EmbeddingProvider, EmbeddingTask } from './EmbeddingProvider';
import { EMBEDDING_PROFILES } from '../constants/embeddingProfiles';
import { EmbeddingIdentity } from '../types/embeddingManifest';

/**
 * Local ONNX embeddings via the already-initialized Xenova feature-extraction
 * pipeline. The worker owns model init and passes the extractor in.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity = EMBEDDING_PROFILES.local;
  // Peak RSS scales with batch × padded sequence length: BERT attention is
  // O(seq²) per head, and the batch pads to its longest doc (up to the model's
  // 512-token cap). Measured over a real 579-doc ADO index: 32 → ~2.2GB peak,
  // 8 → ~0.78GB, for the same total throughput. The larger footprint is the
  // likely cause of the forked embedding worker dying mid-batch with no error.
  readonly maxBatchSize = 8;

  constructor(private extractor: any) {}

  async embedBatch(texts: string[], _task: EmbeddingTask): Promise<number[][]> {
    if (!this.extractor) throw new Error('Local embedding model not initialized');
    if (texts.length === 0) return [];

    // Xenova accepts an array and returns a flat [n * dim] tensor with dims [n, dim].
    const out = await this.extractor(texts, { pooling: 'mean', normalize: true });
    const dim =
      Array.isArray(out.dims) && out.dims.length === 2
        ? out.dims[1]
        : this.identity.dimensions;
    const flat = Array.from(out.data as Float32Array) as number[];
    return texts.map((_, i) => flat.slice(i * dim, (i + 1) * dim));
  }
}
