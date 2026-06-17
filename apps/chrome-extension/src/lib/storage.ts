/**
 * personal — user manages their own Qdrant, Gemini, and LLM keys.
 * team     — all retrieval and chat goes through the admin-hosted proxy;
 *            only proxy URL + access token are needed.
 */
export type AppMode = 'personal' | 'team';

export interface ChromeSettings {
  mode: AppMode;
  qdrant: { url: string; apiKey: string };
  proxy: { url: string; accessToken: string };
  embedding: { apiKey: string };
  llm: { baseUrl: string; apiKey: string; model: string };
}

export const DEFAULT_SETTINGS: ChromeSettings = {
  mode: 'personal',
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
    mode: s.mode ?? DEFAULT_SETTINGS.mode,
    qdrant: { ...DEFAULT_SETTINGS.qdrant, ...(s.qdrant ?? {}) },
    proxy: { ...DEFAULT_SETTINGS.proxy, ...(s.proxy ?? {}) },
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(s.embedding ?? {}) },
    llm: { ...DEFAULT_SETTINGS.llm, ...(s.llm ?? {}) },
  };
}

export async function saveSettings(settings: ChromeSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
