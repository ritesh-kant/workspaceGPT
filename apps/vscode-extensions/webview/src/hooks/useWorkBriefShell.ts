import { useEffect, useState } from 'react';
import { isDesktopHost } from '../vscode';
import { settingsDefaultConfig, useSettingsStore } from '../store/settingsStore';
import type { WorkBriefConfig } from '../types';

/**
 * Settings → Ask about my work (beta, desktop only). Sends the saved settings
 * to the desktop shell, which shows or hides the work-brief icon, keeps it
 * out of screen shares and registers the hotkey (apps/desktop/src-tauri/src/cue.rs),
 * and reports back whether the hotkey could be registered. In VS Code there
 * is no shell, so this does nothing.
 */
export interface WorkBriefShellStatus {
  hotkey: string;
  registered: boolean;
  error?: string | null;
}

interface CueBridge {
  latest(): WorkBriefShellStatus | undefined;
  set(prefs: { enabled: boolean; hideInShares: boolean; hotkey: string }): void;
}

const bridge = (): CueBridge | undefined => (window as { __wgptBridge?: { cue?: CueBridge } }).__wgptBridge?.cue;

/** The saved settings, with defaults for a profile saved before this page existed. */
export function useWorkBriefConfig(): WorkBriefConfig {
  const saved = useSettingsStore((s) => s.config.workBrief);
  return { ...settingsDefaultConfig.workBrief, ...(saved ?? {}) };
}

/** `send: false` only listens (the Settings page); the app root sends. */
export function useWorkBriefShell({ send = true }: { send?: boolean } = {}): WorkBriefShellStatus | undefined {
  const { showIcon, hideInShares, hotkey } = useWorkBriefConfig();
  const [status, setStatus] = useState<WorkBriefShellStatus | undefined>(() => bridge()?.latest());

  useEffect(() => {
    if (!isDesktopHost()) return;
    const onStatus = (e: Event) => setStatus((e as CustomEvent).detail as WorkBriefShellStatus);
    window.addEventListener('wgpt-cue', onStatus);
    return () => window.removeEventListener('wgpt-cue', onStatus);
  }, []);

  useEffect(() => {
    if (!send || !isDesktopHost()) return;
    // Settings load in a burst on startup; send the settled value once.
    const timer = setTimeout(() => bridge()?.set({ enabled: showIcon, hideInShares, hotkey }), 300);
    return () => clearTimeout(timer);
  }, [send, showIcon, hideInShares, hotkey]);

  return status;
}
