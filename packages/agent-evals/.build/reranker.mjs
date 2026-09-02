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
var REMOTE_AUTH = {
  API_BASE: "http://127.0.0.1:8787",
  CALLBACK_PORT: 32329,
  CALLBACK_PATH: "/callback"
};
var REMOTE_INFERENCE_BASE_URL = `${REMOTE_AUTH.API_BASE}/v1`;
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

// ../../apps/vscode-extensions/src/utils/reranker.ts
function deduplicateByFileName(results) {
  const best = /* @__PURE__ */ new Map();
  for (const result of results) {
    const key = result.data.fileName;
    const existing = best.get(key);
    if (!existing || result.score > existing.score) {
      best.set(key, result);
    }
  }
  return Array.from(best.values());
}
function computeBm25Score(query, text) {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) {
    return 0;
  }
  const textLower = text.toLowerCase();
  const matchCount = queryTerms.filter((term) => textLower.includes(term)).length;
  return matchCount / queryTerms.length;
}
function tokenize(text) {
  return [
    ...new Set(
      text.toLowerCase().split(/\W+/).filter((t) => t.length >= 2)
    )
  ];
}
function rerank(query, results, plan) {
  if (results.length === 0 || plan.finalTopK === 0) {
    return [];
  }
  const deduplicated = deduplicateByFileName(results);
  const scored = deduplicated.map((result) => {
    const bm25 = computeBm25Score(query, result.text);
    const combined = result.score * RETRIEVAL_THRESHOLDS.COSINE_WEIGHT + bm25 * RETRIEVAL_THRESHOLDS.BM25_WEIGHT;
    return { ...result, score: combined };
  });
  const filtered = plan.similarityThreshold > 0 ? scored.filter((r) => r.score >= plan.similarityThreshold) : scored;
  return filtered.sort((a, b) => b.score - a.score).slice(0, plan.finalTopK);
}
export {
  computeBm25Score,
  deduplicateByFileName,
  rerank
};
