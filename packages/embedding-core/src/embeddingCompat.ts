import { EmbeddingIdentity, EmbeddingIndexManifest } from './embeddingManifest';

export interface CompatResult {
  ok: boolean;
  reason?: string;
}

/**
 * Can a client using `queryIdentity` safely search an index built with
 * `manifest.embedding`? Compares provider/model/dimensions/normalized and
 * deliberately ignores taskType (RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY is an
 * expected, in-space difference). Returns a human-readable reason on mismatch.
 */
export function checkEmbeddingCompat(
  manifest: Pick<EmbeddingIndexManifest, 'embedding'>,
  queryIdentity: EmbeddingIdentity,
): CompatResult {
  const idx = manifest.embedding;
  if (!idx) {
    return { ok: false, reason: 'Index has no embedding manifest — rebuild it.' };
  }
  if (idx.provider !== queryIdentity.provider) {
    return { ok: false, reason: `Index built with ${idx.provider}, query uses ${queryIdentity.provider}.` };
  }
  if (idx.model !== queryIdentity.model) {
    return { ok: false, reason: `Index model ${idx.model} ≠ query model ${queryIdentity.model}.` };
  }
  if (idx.dimensions !== queryIdentity.dimensions) {
    return { ok: false, reason: `Dimension mismatch: index ${idx.dimensions} vs query ${queryIdentity.dimensions}.` };
  }
  if (idx.normalized !== queryIdentity.normalized) {
    return { ok: false, reason: `Normalization mismatch — both must be ${idx.normalized ? 'normalized' : 'raw'}.` };
  }
  return { ok: true };
}
