/**
 * The Chrome extension is a read-only consumer of a share created in VS Code.
 * It holds nothing but the share token — all credentials live server-side in the
 * Cloudflare Worker, which the token authenticates against. The Worker base URL
 * is fixed at build time (see WORKER_URL).
 */
export interface ChromeSettings {
  shareToken: string;
}

export const DEFAULT_SETTINGS: ChromeSettings = {
  shareToken: '',
};

const KEY = 'workspacegpt-settings';

export async function loadSettings(): Promise<ChromeSettings> {
  const stored = await chrome.storage.local.get(KEY);
  const s = stored[KEY] ?? {};
  return { shareToken: s.shareToken ?? DEFAULT_SETTINGS.shareToken };
}

export async function saveSettings(settings: ChromeSettings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: settings });
}
