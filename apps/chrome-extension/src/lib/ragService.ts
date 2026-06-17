import { WORKER_URL } from './config';
import { ChromeSettings } from './storage';

export type SourceName = 'CONFLUENCE' | 'ADO' | 'CODEBASE';

/**
 * Browser-side RAG, fully proxied. The Chrome extension sends the question and
 * token to the Worker, which embeds the query, searches Qdrant, and streams the
 * chat answer — all using credentials the extension never sees.
 */
export async function* answerQuestion(
  settings: ChromeSettings,
  question: string,
  sources: SourceName[] = ['CONFLUENCE', 'ADO'],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!settings.shareToken) {
    throw new Error('Not connected. Paste your share code in Settings.');
  }

  const auth = { Authorization: `Bearer ${settings.shareToken}` };

  // 1. Retrieval — Worker embeds the query and searches Qdrant server-side.
  const searchRes = await fetch(`${WORKER_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ query: question, sources }),
    signal,
  });
  if (searchRes.status === 401) {
    throw new Error('Share code is invalid or has been revoked. Get a new one from the admin.');
  }
  if (!searchRes.ok) {
    throw new Error(`Search failed: ${searchRes.status} ${await searchRes.text().catch(() => '')}`);
  }
  const { hits } = (await searchRes.json()) as {
    hits: { text: string; score: number; data: { fileName: string } }[];
  };

  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.data.fileName}\n${h.text}`).join('\n\n')
    : '(no relevant documents found)';

  // 2. Chat — Worker streams the completion back as SSE.
  const chatRes = await fetch(`${WORKER_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
      ],
    }),
    signal,
  });
  if (!chatRes.ok || !chatRes.body) {
    throw new Error(`Chat failed: ${chatRes.status} ${await chatRes.text().catch(() => '')}`);
  }

  yield* parseSSE(chatRes.body, signal);
}

const SYSTEM_PROMPT = `You are WorkspaceGPT, a helpful assistant. Answer the user's question using ONLY the provided context from their Confluence and Azure DevOps knowledge base. If the context does not contain the answer, say so plainly. Reference the source titles in [brackets] when relevant.`;

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
