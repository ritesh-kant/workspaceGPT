import { GeminiEmbeddingProvider, QdrantVectorStore, SearchHit, SourceName, embedOne } from '@workspace-gpt/embedding-core';
import { ChromeSettings, isConfigured } from './storage';
import { buildPlan, classifyQuery, expandQuery, rerank } from './retrieval';
import { buildChatMessages, isGreeting } from './prompt';
import { withKeyFailover } from './keyFailover';

export type { SourceName };

/**
 * Pass 1 already produced at least this many hits above the relevance threshold,
 * so the second embed+search (~1–2s of extra serial round-trips) would only
 * reorder good context, not find missing context. Skip it. Pass 2 still runs
 * when pass 1 comes back thin (weak or empty), which is when widening helps.
 */
const PASS2_MIN_HITS = 3;

/** Progress phases surfaced to the UI so the unavoidable network waits feel responsive. */
export type RagStatus = 'searching' | 'searching-deeper' | 'generating';

/**
 * Full browser-side RAG: classify the query, embed it with Gemini, retrieve from
 * Qdrant across the planned sources, rerank + threshold-filter the hits, then
 * stream a grounded answer from the configured LLM — all using the credentials
 * carried in the share code. No server in between.
 *
 * Mirrors the VS Code extension's pipeline (queryClassifier → queryPlanner →
 * reranker → grounded prompt) so answers match. Greetings and low-relevance
 * queries retrieve no context instead of dumping nearest-neighbour noise.
 *
 * `onStatus` reports the current phase (the steps are sequential network hops,
 * 1–6s total); the caller clears it when the first token streams in.
 */
export async function* answerQuestion(
  settings: ChromeSettings,
  question: string,
  sources: SourceName[] = ['CONFLUENCE', 'ADO'],
  signal?: AbortSignal,
  onStatus?: (status: RagStatus) => void,
): AsyncGenerator<string> {
  if (!isConfigured(settings)) {
    throw new Error('Not connected. Paste your share code in Settings.');
  }

  // ── Classify + plan. Greetings/chitchat skip retrieval entirely. ──
  const classification = classifyQuery(question, sources);
  const plan = buildPlan(classification);

  let hits: SearchHit[] = [];
  if (!isGreeting(question) && plan.sources.length > 0 && plan.topKPerPass > 0) {
    const provider = new GeminiEmbeddingProvider(settings.gemini.apiKeys);
    const store = new QdrantVectorStore({
      url: settings.qdrant.url,
      apiKey: settings.qdrant.apiKey,
      collectionPrefix: settings.qdrant.collectionPrefix,
    });

    const search = async (vec: number[], topK: number): Promise<SearchHit[]> => {
      const perSource = await Promise.all(
        plan.sources.map((s) => store.search(vec, topK, s).catch(() => [] as SearchHit[])),
      );
      return perSource.flat();
    };

    onStatus?.('searching');
    const queryVec = await embedOne(provider, question, 'query');
    const allResults = await search(queryVec, plan.topKPerPass);

    // Rerank (BM25 + cosine), dropping anything below the per-intent threshold.
    hits = rerank(question, allResults, plan);

    // Pass 2 (semantic only): only pay for the second embed+search when pass 1
    // came back thin. If pass 1 already cleared the threshold with enough hits,
    // widening just reorders good context — not worth the extra ~1–2s of waiting.
    if (plan.maxPasses === 2 && hits.length < PASS2_MIN_HITS) {
      const enriched = expandQuery(question, allResults);
      if (enriched !== question) {
        onStatus?.('searching-deeper');
        const pass2Vec = await embedOne(provider, enriched, 'query');
        const pass2Results = await search(pass2Vec, plan.topKPerPass);
        hits = rerank(question, [...allResults, ...pass2Results], plan);
      }
    }
  }

  onStatus?.('generating');
  // Tried in order; a 429 from one key fails over to the next before the
  // stream starts (once tokens are streaming there's no way to retry mid-flight).
  const res = await withKeyFailover(settings.llm.apiKeys, async (apiKey) => {
    const r = await fetch(`${settings.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.llm.model,
        stream: true,
        messages: buildChatMessages(question, hits),
      }),
      signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw Object.assign(new Error(`Chat failed: ${r.status} ${body}`), { status: r.status });
    }
    return r;
  });
  if (!res.body) {
    throw new Error('Chat failed: empty response body.');
  }

  yield* parseSSE(res.body, signal);
}

/** Parse an OpenAI-compatible SSE stream, yielding content deltas. */
async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (signal?.aborted) {
      await reader.cancel();
      return;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // partial JSON across chunk boundary — ignore, next read completes it
      }
    }
  }
}
