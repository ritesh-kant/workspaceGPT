import { RETRIEVAL_THRESHOLDS } from '../../constants';
import { EmbeddingSearchResult, RetrievalPlan } from 'src/types/types';

// ── Deduplication ──────────────────────────────────────────────────────

/**
 * Removes duplicate results for the same source file, keeping the one
 * with the highest score per unique fileName.
 */
export function deduplicateByFileName(
  results: EmbeddingSearchResult[]
): EmbeddingSearchResult[] {
  const best = new Map<string, EmbeddingSearchResult>();
  for (const result of results) {
    const key = result.data.fileName;
    const existing = best.get(key);
    if (!existing || result.score > existing.score) {
      best.set(key, result);
    }
  }
  return Array.from(best.values());
}

// ── BM25-lite scoring ──────────────────────────────────────────────────

/**
 * Lightweight BM25-inspired term coverage score.
 * Returns the proportion of unique query terms found in the document text (0–1).
 * This captures lexical overlap that pure cosine similarity can miss.
 */
export function computeBm25Score(query: string, text: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return 0;
  }
  const textLower = text.toLowerCase();
  const matchCount = queryTerms.filter((term) => textLower.includes(term)).length;
  return matchCount / queryTerms.length;
}

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length >= 2)
    ),
  ];
}

// ── Reranker ───────────────────────────────────────────────────────────

/**
 * Reranks a set of retrieval results using a BM25+cosine blend, then
 * filters by similarity threshold and caps at finalTopK.
 *
 * Combined score = cosine × COSINE_WEIGHT + bm25 × BM25_WEIGHT
 */
export function rerank(
  query: string,
  results: EmbeddingSearchResult[],
  plan: RetrievalPlan
): EmbeddingSearchResult[] {
  if (results.length === 0 || plan.finalTopK === 0) {
    return [];
  }

  // 1. Remove duplicates first to avoid the same chunk appearing twice
  const deduplicated = deduplicateByFileName(results);

  // 2. Compute combined scores
  const scored = deduplicated.map((result) => {
    const bm25 = computeBm25Score(query, result.text);
    const combined =
      result.score * RETRIEVAL_THRESHOLDS.COSINE_WEIGHT +
      bm25 * RETRIEVAL_THRESHOLDS.BM25_WEIGHT;
    return { ...result, score: combined };
  });

  // 3. Filter out results below the similarity threshold
  const filtered =
    plan.similarityThreshold > 0
      ? scored.filter((r) => r.score >= plan.similarityThreshold)
      : scored;

  // 4. Sort descending by combined score and cap at finalTopK
  return filtered
    .sort((a, b) => b.score - a.score)
    .slice(0, plan.finalTopK);
}
