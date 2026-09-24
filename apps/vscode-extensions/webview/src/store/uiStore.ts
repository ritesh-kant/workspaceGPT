import { create } from 'zustand';

/**
 * Which full-screen/overlay panel is showing. Deliberately a single value
 * (not a boolean per panel) so only one panel can ever be active — the old
 * per-panel booleans split across settingsStore/chatStore let two panels be
 * true at once (e.g. Settings opened without clearing Releases), which
 * rendered them stacked with no way to tell. Not persisted: which panel is
 * open is session-transient UI state, not something to restore on reload.
 */
export type ActiveView = 'chat' | 'settings' | 'history' | 'releases' | 'onboarding';

interface UiState {
  activeView: ActiveView;
  /** True once the persisted settings blob has been requested and applied.
   *  Gates onboarding/mode-dependent rendering so a returning user never sees
   *  a flash of the first-run flow before their real config loads. */
  settingsHydrated: boolean;
  /** A Settings page to land on the next time Settings opens (the desktop's
   *  page layout, see components/Settings.tsx); consumed once it is shown. */
  settingsPage: string | null;
  setActiveView: (view: ActiveView) => void;
  setSettingsHydrated: (hydrated: boolean) => void;
  /** Open Settings, optionally on a given page. */
  openSettings: (page?: string) => void;
  clearSettingsPage: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeView: 'chat',
  settingsHydrated: false,
  settingsPage: null,
  setActiveView: (activeView) => set({ activeView }),
  setSettingsHydrated: (settingsHydrated) => set({ settingsHydrated }),
  openSettings: (page) => set({ activeView: 'settings', settingsPage: page ?? null }),
  clearSettingsPage: () => set({ settingsPage: null }),
}));
