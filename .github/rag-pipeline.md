# RAG Pipeline — Multi-Pass Retrieval Implementation

Replaces the original single-shot `Promise.all → slice(0,15)` with a 5-stage chain:
**classify → plan → search (concurrent with LLM upgrade) → optional pass 2 → rerank → LLM**

---

## New Files

### `apps/vscode-extensions/src/utils/queryClassifier.ts`
`classifyQuery(query, availableSources): QueryClassification`

Rule-based intent detection via regex priority ladder:

| Priority | Intent | Pattern |
|---|---|---|
| 1 | `chitchat` | greeting/farewell words |
| 2 | `lookup` | numeric IDs (`\d{5,}`) or ticket keys (`[A-Z]+-\d+`) |
| 3 | `aggregation` | "list all", "how many", "show all tickets/bugs" |
| 4 | `comparison` | "vs", "compare", "difference between" |
| 5 | `semantic` | "how/what/why/explain..." |
| default | `semantic` | confidence: `low` |

Source routing: ADO keywords vs Confluence keywords vs fallback to all available sources. Returns `confidence: 'low'` when ambiguous — triggers optional LLM upgrade in `chatService`.

---

### `apps/vscode-extensions/src/utils/queryPlanner.ts`
`buildPlan(classification): RetrievalPlan`

| Intent | topKPerPass | finalTopK | maxPasses | passThreshold | simThreshold |
|---|---|---|---|---|---|
| chitchat | 0 | 0 | 1 | — | 0 |
| lookup | 20 | 5 | 1 | — | 0.20 |
| aggregation | 25 | 15 | 1 | — | 0.20 |
| **semantic** | 20 | 10 | **2** | **0.45** | **0.30** |
| comparison | 20 | 8 | 1 | — | 0.30 |

`expandQuery(originalQuery, pass1Results): string` — extracts numeric IDs from filenames and capitalized tokens (proper nouns) from the top-3 pass-1 results, appends up to 5 unique terms to enrich the pass-2 query.

---

### `apps/vscode-extensions/src/utils/reranker.ts`
`rerank(query, results, plan): EmbeddingSearchResult[]`

1. `deduplicateByFileName` — keeps highest-score result per source file
2. `computeBm25Score` — query term coverage ratio (matching terms / total query terms, 0–1)
3. Combined score: `cosine × 0.65 + BM25 × 0.35`
4. Filter `< plan.similarityThreshold`
5. Sort descending, return `slice(finalTopK)`

---

## Modified Files

### `apps/vscode-extensions/constants.ts`
```ts
RETRIEVAL_THRESHOLDS = {
  LOOKUP_MIN_SCORE: 0.2,
  AGGREGATION_MIN_SCORE: 0.2,
  SEMANTIC_MIN_SCORE: 0.3,
  COMPARISON_MIN_SCORE: 0.3,
  SEMANTIC_PASS2_TRIGGER: 0.45,
  COSINE_WEIGHT: 0.65,
  BM25_WEIGHT: 0.35,
}
```
Also added `RETRIEVAL_STATUS` message type.

### `apps/vscode-extensions/src/types/types.ts`
Added: `QueryIntent`, `DataSource`, `QueryClassification`, `RetrievalPlan`.
Fixed: `EmbeddingSearchResult.data.sourceName` union now includes `'ADO'` (was `'CONFLUENCE' | 'CODEBASE'` only).

### `apps/vscode-extensions/src/workers/common/searchProcess.ts`
`SearchMessage` accepts optional `topK?: number`. Worker uses `topK ?? MAX_SEARCH_RESULTS` instead of the hardcoded constant.

### `apps/vscode-extensions/src/services/confluence/confluenceEmbeddingService.ts`
### `apps/vscode-extensions/src/services/ado/adoEmbeddingService.ts`
`searchEmbeddings(query, topK?)` — forwards `topK` to the worker message. ADO service also fixed `sourceName: 'ADO' as const` (was `as any`).

---

## `chatService.ts` Pipeline

**Removed:** `classifyQueryContext()`, `combineSearchResults()`, dead `augmentQueryWithUserName()`

**Added:** `postStatus(text)`, `searchSource(source, query, topK)`, `classifyIntentWithLLM()`

**`classifyIntentWithLLM` rules:**
- Updates **intent only** — source routing always stays rule-determined
- Only fires when: `confidence === 'low'` AND `contextSelection === 'Auto'` AND both sources connected AND cloud provider + apiKey available
- Skipped for local Ollama
- JSON prompt: `{"intent": "<lookup|semantic|aggregation|comparison|chitchat>"}`, graceful fallback on parse error

**Full pipeline (concurrent fan-out optimization):**
```
1. classifyQuery()           ← synchronous, zero latency
2. buildPlan()               ← preliminary plan from rules
3. Promise.all([             ← CONCURRENT — search does NOT wait for LLM
     search pass 1,
     classifyIntentWithLLM   ← only if: low confidence + auto + cloud + both sources
   ])
4. Rebuild plan with upgraded intent (if changed)
5. Pass 2?                   ← only for semantic intent AND bestScore < 0.45
     expandQuery() → re-search same sources
6. rerank()                  ← BM25+cosine blend, dedup, threshold filter
7. generateModelResponse()
```

Chitchat intent skips all retrieval (steps 3–6).

---

## Status Indicator (Webview)

| Pipeline moment | Text shown |
|---|---|
| Vector search | `Searching Confluence...` / `Searching Azure DevOps...` / `Searching Confluence & Azure DevOps...` |
| Pass 2 triggered | `Expanding search...` |
| Reranking | `Ranking results...` |
| LLM generating | `Thinking...` |

**Files changed:**
- `webview/src/store/chatStore.ts` — `statusText` + `setStatusText`
- `webview/src/App.tsx` — handles `RETRIEVAL_STATUS`, clears on done/error/new-chat
- `webview/src/App.css` — pulsing dot animation (replaces static italic "Thinking...")
