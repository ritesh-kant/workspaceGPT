export type ProxyMode = 'direct' | 'proxy';

export interface ChromeSettings {
  vectorStoreMode: ProxyMode;
  llmMode: ProxyMode;
  qdrant: { url: string; apiKey: string };        // vector store direct mode
  proxy: { url: string; accessToken: string };    // shared proxy (both Qdrant + LLM)
  embedding: { apiKey: string };                  // Gemini key (query embeddings — always direct)
  llm: { baseUrl: string; apiKey: string; model: string };  // llm direct mode
}

export const DEFAULT_SETTINGS: ChromeSettings = {
  vectorStoreMode: 'direct',
  llmMode: 'direct',
  qdrant: { url: '', apiKey: '' },
  proxy: { url: '', accessToken: '' },
  embedding: { apiKey: '' },
  llm: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    model: 'gemini-2.0-flash',
  },
};

const KEY = 'workspacegpt-settings';

export async function loadSettings(): Promise<ChromeSettings> {
  const stored = await chrome.storage.local.get(KEY);
  const s = stored[KEY] ?? {};
  return {
    vectorStoreMode: s.vectorStoreMode ?? DEFAULT_SETTINGS.vectorStoreMode,
    llmMode: s.llmMode ?? DEFAULT_SETTINGS.llmMode,
    qdrant: { ...DEFAULT_SETTINGS.qdrant, ...(s.qdrant ?? {}) },
    proxy: { ...DEFAULT_SETTINGS.proxy, ...(s.proxy ?? {}) },
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(s.embedding ?? {}) },
    llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm ?? {}) },
  };
}

export async function saveSettings(settings: ChromeSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
