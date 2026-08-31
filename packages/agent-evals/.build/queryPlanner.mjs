// ../../apps/vscode-extensions/constants.ts
var ATTACHMENT_LIMITS = {
  /** Max attachments per message. */
  MAX_FILES: 4,
  /** Max raw size for an image attachment (base64 inflates ~33% on top). */
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  /** Text files are inlined into the prompt — truncate beyond this. */
  MAX_TEXT_CHARS: 1e5
};
var RETRIEVAL_THRESHOLDS = {
  // Per-intent minimum combined (cosine + BM25) score to include a result
  LOOKUP_MIN_SCORE: 0.2,
  AGGREGATION_MIN_SCORE: 0.2,
  SEMANTIC_MIN_SCORE: 0.3,
  COMPARISON_MIN_SCORE: 0.3,
  // If the best pass-1 score is below this, a second retrieval pass is triggered (semantic only)
  SEMANTIC_PASS2_TRIGGER: 0.45,
  // Reranker blend weights (must sum to 1.0)
  COSINE_WEIGHT: 0.65,
  BM25_WEIGHT: 0.35
};
var SYNC_INTERVAL_MS = 15 * 60 * 1e3;
var UPDATE_CHECK = {
  OPEN_VSX_API_URL: "https://open-vsx.org/api/Riteshkant/workspacegpt-extension",
  RELEASES_URL: "https://github.com/ritesh-kant/workspaceGPT/releases/tag/workspaceGPT-v",
  EXTENSION_ID: "Riteshkant.workspacegpt-extension",
  // Re-check periodically for long-lived windows; a fresh check also always
  // runs once per activation (delayed so it never competes with startup work).
  CHECK_INTERVAL_MS: 12 * 60 * 60 * 1e3,
  // 12 hours
  FIRST_CHECK_DELAY_MS: 30 * 1e3,
  // 30 seconds
  REQUEST_TIMEOUT_MS: 5 * 1e3
};

// ../../apps/vscode-extensions/src/utils/queryPlanner.ts
var PLAN_BY_INTENT = {
  chitchat: {
    topKPerPass: 0,
    finalTopK: 0,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: 0
  },
  lookup: {
    topKPerPass: 20,
    finalTopK: 5,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: RETRIEVAL_THRESHOLDS.LOOKUP_MIN_SCORE
  },
  aggregation: {
    topKPerPass: 25,
    finalTopK: 15,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: RETRIEVAL_THRESHOLDS.AGGREGATION_MIN_SCORE
  },
  semantic: {
    topKPerPass: 20,
    finalTopK: 10,
    maxPasses: 2,
    passThreshold: RETRIEVAL_THRESHOLDS.SEMANTIC_PASS2_TRIGGER,
    similarityThreshold: RETRIEVAL_THRESHOLDS.SEMANTIC_MIN_SCORE
  },
  comparison: {
    topKPerPass: 20,
    finalTopK: 8,
    maxPasses: 1,
    passThreshold: 0,
    similarityThreshold: RETRIEVAL_THRESHOLDS.COMPARISON_MIN_SCORE
  }
};
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "about",
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "that",
  "this",
  "it",
  "its",
  "me",
  "my",
  "i",
  "we",
  "our",
  "you",
  "your",
  "they",
  "their"
]);
function buildPlan(classification) {
  const config = PLAN_BY_INTENT[classification.intent];
  return {
    ...config,
    sources: classification.sources,
    intent: classification.intent
  };
}
function expandQuery(originalQuery, pass1Results) {
  const keyTerms = [];
  const topResults = [...pass1Results].sort((a, b) => b.score - a.score).slice(0, 3);
  for (const result of topResults) {
    const idMatches = result.data.fileName.match(/\d{4,}/g) || [];
    keyTerms.push(...idMatches);
    const properNouns = result.text.split(/\s+/).filter((token) => {
      const clean = token.replace(/[^a-zA-Z]/g, "");
      return clean.length >= 3 && /^[A-Z]/.test(clean) && !STOPWORDS.has(clean.toLowerCase());
    }).map((t) => t.replace(/[^a-zA-Z0-9]/g, "")).filter(Boolean);
    keyTerms.push(...properNouns);
  }
  const originalLower = originalQuery.toLowerCase();
  const uniqueTerms = [...new Set(keyTerms)].filter((t) => !originalLower.includes(t.toLowerCase())).slice(0, 5);
  if (uniqueTerms.length === 0) {
    return originalQuery;
  }
  return `${originalQuery} ${uniqueTerms.join(" ")}`;
}
export {
  buildPlan,
  expandQuery
};
