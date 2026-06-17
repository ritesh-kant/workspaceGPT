import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';
import { embedOne } from './EmbeddingProvider';
import { QdrantVectorStore } from './QdrantVectorStore';
import { SourceName } from './VectorStore';
import { ChatMessage, streamChat } from './llm';
import { ChromeSettings } from './storage';

const SYSTEM_PROMPT = `You are WorkspaceGPT, a helpful assistant. Answer the user's question using ONLY the provided context from their Confluence and Azure DevOps knowledge base. If the context does not contain the answer, say so plainly. Reference the source titles in [brackets] when relevant.`;

const TOP_K = 8;

/**
 * Full browser-side RAG: embed the query with Gemini, retrieve from Qdrant across
 * the selected sources, then stream an answer from the configured LLM.
 */
export async function* answerQuestion(
  settings: ChromeSettings,
  question: string,
  sources: SourceName[] = ['CONFLUENCE', 'ADO'],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!settings.embedding.apiKey) throw new Error('Set your Gemini API key in Settings.');
  if (!settings.qdrant.url) throw new Error('Set your Qdrant URL in Settings.');
  if (!settings.llm.apiKey) throw new Error('Set your chat model API key in Settings.');

  const provider = new GeminiEmbeddingProvider(settings.embedding.apiKey);
  const store = new QdrantVectorStore({
    url: settings.qdrant.url,
    apiKey: settings.qdrant.apiKey,
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

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Context:\n${context}\n\nQuestion: ${question}` },
  ];

  yield* streamChat(settings.llm, messages, signal);
}
