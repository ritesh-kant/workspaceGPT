import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';
import { embedOne } from './EmbeddingProvider';
import { QdrantVectorStore } from './QdrantVectorStore';
import { ProxyVectorStore } from './ProxyVectorStore';
import { SourceName, VectorStore } from './VectorStore';
import { ChatMessage, LlmConfig, LlmProxyConfig, streamChat } from './llm';
import { ChromeSettings } from './storage';

const SYSTEM_PROMPT = `You are WorkspaceGPT, a helpful assistant. Answer the user's question using ONLY the provided context from their Confluence and Azure DevOps knowledge base. If the context does not contain the answer, say so plainly. Reference the source titles in [brackets] when relevant.`;

const TOP_K = 8;

function buildStore(settings: ChromeSettings): VectorStore {
  if (settings.vectorStoreMode === 'proxy') {
    if (!settings.proxy.url) throw new Error('Set the proxy URL in Settings.');
    if (!settings.proxy.accessToken) throw new Error('Set the proxy access token in Settings.');
    return new ProxyVectorStore({ url: settings.proxy.url, accessToken: settings.proxy.accessToken });
  }
  if (!settings.qdrant.url) throw new Error('Set your Qdrant URL in Settings.');
  return new QdrantVectorStore({ url: settings.qdrant.url, apiKey: settings.qdrant.apiKey });
}

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

  let llmCfg: LlmConfig | LlmProxyConfig;
  if (settings.llmMode === 'proxy') {
    if (!settings.proxy.url) throw new Error('Set the proxy URL in Settings.');
    if (!settings.proxy.accessToken) throw new Error('Set the proxy access token in Settings.');
    llmCfg = { proxyUrl: settings.proxy.url, accessToken: settings.proxy.accessToken, model: settings.llm.model };
  } else {
    if (!settings.llm.apiKey) throw new Error('Set your chat model API key in Settings.');
    llmCfg = settings.llm;
  }

  const provider = new GeminiEmbeddingProvider(settings.embedding.apiKey);
  const store = buildStore(settings);

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

  yield* streamChat(llmCfg, messages, signal);
}
