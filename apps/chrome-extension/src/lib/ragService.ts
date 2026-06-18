import { GeminiEmbeddingProvider, QdrantVectorStore, embedOne } from '@workspace-gpt/embedding-core';
import { ChromeSettings, isConfigured } from './storage';

export type SourceName = 'CONFLUENCE' | 'ADO' | 'CODEBASE';

const SYSTEM_PROMPT = `You are WorkspaceGPT, a helpful assistant. Answer the user's question using ONLY the provided context from their Confluence and Azure DevOps knowledge base. If the context does not contain the answer, say so plainly. Reference the source titles in [brackets] when relevant.`;

const TOP_K = 8;

/**
 * Full browser-side RAG: embed the query with Gemini, retrieve from Qdrant across
 * the selected sources, then stream an answer from the configured LLM — all using
 * the credentials carried in the share code. No server in between.
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

  const provider = new GeminiEmbeddingProvider(settings.gemini.apiKey);
  const store = new QdrantVectorStore({
    url: settings.qdrant.url,
    apiKey: settings.qdrant.apiKey,
    collectionPrefix: settings.qdrant.collectionPrefix,
  });

  const queryVec = await embedOne(provider, question, 'query');

  const perSource = await Promise.all(
    sources.map((s) => store.search(queryVec, TOP_K, s).catch(() => [])),
  );
  const hits = perSource
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.data.fileName}\n${h.text}`).join('\n\n')
    : '(no relevant documents found)';

  const res = await fetch(`${settings.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.llm.model,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
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
