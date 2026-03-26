import { RETRIEVAL_THRESHOLDS } from '../../constants';
import { EmbeddingSearchResult, QueryClassification, QueryIntent, RetrievalPlan } from 'src/types/types';

// ── Plan table ─────────────────────────────────────────────────────────

interface PlanConfig {
  topKPerPass: number;
  finalTopK: number;
  maxPasses: number;
  passThreshold: number;
  similarityThreshold: number;
}

const PLAN_BY_INTENT: Record<QueryIntent, PlanConfig> = {
  chitchat: {
    topKPerPass: 0,
    finalTopK: 0,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: 0,
  },
  lookup: {
    topKPerPass: 20,
    finalTopK: 5,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: RETRIEVAL_THRESHOLDS.LOOKUP_MIN_SCORE,
  },
  aggregation: {
    topKPerPass: 25,
    finalTopK: 15,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: RETRIEVAL_THRESHOLDS.AGGREGATION_MIN_SCORE,
  },
  semantic: {
    topKPerPass: 20,
    finalTopK: 10,
    maxPasses: 2,
    passThreshold: RETRIEVAL_THRESHOLDS.SEMANTIC_PASS2_TRIGGER,
    similarityThreshold: RETRIEVAL_THRESHOLDS.SEMANTIC_MIN_SCORE,
  },
  comparison: {
    topKPerPass: 20,
    finalTopK: 8,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: RETRIEVAL_THRESHOLDS.COMPARISON_MIN_SCORE,
  },
};

// ── Stopwords for query expansion ──────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'about', 'what', 'how',
  'why', 'when', 'where', 'who', 'which', 'that', 'this', 'it', 'its',
  'me', 'my', 'i', 'we', 'our', 'you', 'your', 'they', 'their',
]);

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Translates a query classification into a concrete retrieval configuration.
 */
export function buildPlan(classification: QueryClassification): RetrievalPlan {
  const config = PLAN_BY_INTENT[classification.intent];
  return {
    ...config,
    sources: classification.sources,
    intent: classification.intent,
  };
}

/**
 * Builds an enriched query for pass 2 by extracting key terms from pass-1 results.
 * Appends up to 5 unique terms (IDs + proper noun tokens) to the original query.
 */
export function expandQuery(
  originalQuery: string,
  pass1Results: EmbeddingSearchResult[]
): string {
  const keyTerms: string[] = [];

  // Take top-3 results by score for term extraction
  const topResults = [...pass1Results]
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  for (const result of topResults) {
    // Extract numeric IDs from filenames (e.g. "ADO-98765" → "98765")
    const idMatches = result.data.fileName.match(/\d{4,}/g) || [];
    keyTerms.push(...idMatches);

    // Extract capitalized tokens from text that look like proper nouns / acronyms
    const properNouns = result.text
      .split(/\s+/)
      .filter((token) => {
        const clean = token.replace(/[^a-zA-Z]/g, '');
        return (
          clean.length >= 3 &&
          /^[A-Z]/.test(clean) &&
          !STOPWORDS.has(clean.toLowerCase())
        );
      })
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(Boolean);

    keyTerms.push(...properNouns);
  }

  // Deduplicate, remove any terms already in the original query, cap at 5
  const originalLower = originalQuery.toLowerCase();
  const uniqueTerms = [...new Set(keyTerms)]
    .filter((t) => !originalLower.includes(t.toLowerCase()))
    .slice(0, 5);

  if (uniqueTerms.length === 0) {
    return originalQuery;
  }

  return `${originalQuery} ${uniqueTerms.join(' ')}`;
}
