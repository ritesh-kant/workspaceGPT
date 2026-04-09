/**
 * Standalone reranker for the MCP server.
 * Adapted from the VS Code extension's reranker.ts — no vscode dependencies.
 */

export interface SearchResult {
  text: string;
  score: number;
  data: {
    sourceName: 'CONFLUENCE' | 'ADO';
    source: string;   // URL
    fileName: string;
  };
}

// ── Thresholds (mirrored from the extension's constants) ────────────────

const COSINE_WEIGHT = 0.65;
const BM25_WEIGHT = 0.35;
const DEFAULT_SIMILARITY_THRESHOLD = 0.2;

// ── Deduplication ───────────────────────────────────────────────────────

/**
 * Removes duplicate results for the same source file, keeping the one
 * with the highest score per unique fileName.
 */
export function deduplicateByFileName(results: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const result of results) {
    const key = result.data.fileName;
    const existing = best.get(key);
    if (!existing || result.score > existing.score) {
      best.set(key, result);
    }
  }
  return Array.from(best.values());
}

// ── BM25-lite scoring ───────────────────────────────────────────────────

/**
 * Lightweight BM25-inspired term coverage score.
 * Returns the proportion of unique query terms found in the document text (0–1).
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

// ── Reranker ────────────────────────────────────────────────────────────

/**
 * Reranks a set of retrieval results using a BM25 + cosine blend, then
 * filters by similarity threshold and caps at finalTopK.
 */
export function rerank(
  query: string,
  results: SearchResult[],
  finalTopK: number = 10,
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD
): SearchResult[] {
  if (results.length === 0 || finalTopK === 0) {
    return [];
  }

  // 1. Remove duplicates
  const deduplicated = deduplicateByFileName(results);

  // 2. Compute combined scores
  const scored = deduplicated.map((result) => {
    const bm25 = computeBm25Score(query, result.text);
    const combined = result.score * COSINE_WEIGHT + bm25 * BM25_WEIGHT;
    return { ...result, score: combined };
  });

  // 3. Filter below threshold
  const filtered =
    similarityThreshold > 0
      ? scored.filter((r) => r.score >= similarityThreshold)
      : scored;

  // 4. Sort descending and cap
  return filtered.sort((a, b) => b.score - a.score).slice(0, finalTopK);
}
