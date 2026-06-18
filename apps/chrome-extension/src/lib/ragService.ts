import { GeminiEmbeddingProvider, QdrantVectorStore, SearchHit, SourceName, embedOne } from '@workspace-gpt/embedding-core';
import { ChromeSettings, isConfigured } from './storage';
import { buildPlan, classifyQuery, expandQuery, rerank } from './retrieval';
import { buildChatMessages, isGreeting } from './prompt';

export type { SourceName };

/**
 * Full browser-side RAG: classify the query, embed it with Gemini, retrieve from
 * Qdrant across the planned sources, rerank + threshold-filter the hits, then
 * stream a grounded answer from the configured LLM — all using the credentials
 * carried in the share code. No server in between.
 *
 * Mirrors the VS Code extension's pipeline (queryClassifier → queryPlanner →
 * reranker → grounded prompt) so answers match. Greetings and low-relevance
 * queries retrieve no context instead of dumping nearest-neighbour noise.
 */
export async function* answerQuestion(
  settings: ChromeSettings,
  question: string,
  sources: SourceName[] = ['CONFLUENCE', 'ADO'],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!isConfigured(settings)) {
    throw new Error('Not connected. Paste your share code in Settings.');
  }

  // ── Classify + plan. Greetings/chitchat skip retrieval entirely. ──
  const classification = classifyQuery(question, sources);
  const plan = buildPlan(classification);

  let hits: SearchHit[] = [];
  if (!isGreeting(question) && plan.sources.length > 0 && plan.topKPerPass > 0) {
    const provider = new GeminiEmbeddingProvider(settings.gemini.apiKey);
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

    const queryVec = await embedOne(provider, question, 'query');
    let allResults = await search(queryVec, plan.topKPerPass);

    // Pass 2 (semantic only): if the best pass-1 hit is weak, widen the query.
    if (plan.maxPasses === 2 && allResults.length > 0) {
      const bestScore = Math.max(...allResults.map((r) => r.score));
      if (bestScore < plan.passThreshold) {
        const enriched = expandQuery(question, allResults);
        if (enriched !== question) {
          const pass2Vec = await embedOne(provider, enriched, 'query');
          allResults = [...allResults, ...(await search(pass2Vec, plan.topKPerPass))];
        }
      }
    }

    // Rerank (BM25 + cosine) and drop anything below the per-intent threshold.
    hits = rerank(question, allResults, plan);
  }

  const res = await fetch(`${settings.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.llm.model,
      stream: true,
      messages: buildChatMessages(question, hits),
    }),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`Chat failed: ${res.status} ${await res.text().catch(() => '')}`);
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
