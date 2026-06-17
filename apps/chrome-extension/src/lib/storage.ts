export interface ChromeSettings {
  qdrant: { url: string; apiKey: string };
  embedding: { apiKey: string }; // Gemini key (query embeddings)
  llm: { baseUrl: string; apiKey: string; model: string };
}

export const DEFAULT_SETTINGS: ChromeSettings = {
  qdrant: { url: '', apiKey: '' },
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
    qdrant: { ...DEFAULT_SETTINGS.qdrant, ...(s.qdrant ?? {}) },
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(s.embedding ?? {}) },
    llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm ?? {}) },
  };
}

export async function saveSettings(settings: ChromeSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
