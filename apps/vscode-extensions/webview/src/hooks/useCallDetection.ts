import { useEffect, useState } from 'react';
import { isDesktopHost } from '../vscode';
import { useSettingsStore } from '../store/settingsStore';

/**
 * Call notes (beta, desktop only): whether the desktop host can detect calls
 * here, and whether the user is in one now (apps/desktop/sidecar/host/callDetection.ts).
 * Turns detection on or off as Settings → Call notes changes. In VS Code there is
 * no bridge, so this reports unavailable and does nothing.
 */
interface CallsBridge {
  latest(): { capability?: CallCapability; state?: CallState };
  request(op: 'enable' | 'disable'): void;
}
export interface CallCapability {
  available: boolean;
  reason?: string;
}
export interface CallState {
  inCall: boolean;
  /** When the call's audio started (ms since epoch); identifies this call. */
  since?: number;
}

const bridge = (): CallsBridge | undefined => (window as { __wgptBridge?: { calls?: CallsBridge } }).__wgptBridge?.calls;

export function useCallDetection(): { enabled: boolean; capability: CallCapability | undefined; state: CallState } {
  const enabled = useSettingsStore((s) => !!s.config.callNotes?.enabled);
  const [capability, setCapability] = useState<CallCapability | undefined>(() => bridge()?.latest().capability);
  const [state, setState] = useState<CallState>(() => bridge()?.latest().state ?? { inCall: false });

  useEffect(() => {
    if (!isDesktopHost()) return;
    const onEvent = (e: Event) => {
      const event = (e as CustomEvent).detail as ({ type?: string } & Partial<CallCapability> & Partial<CallState>) | undefined;
      if (event?.type === 'capability') setCapability({ available: !!event.available, reason: event.reason });
      else if (event?.type === 'state') setState({ inCall: !!event.inCall, since: event.since });
    };
    window.addEventListener('wgpt-calls', onEvent);
    return () => window.removeEventListener('wgpt-calls', onEvent);
  }, []);

  // The host forgets on restart; re-sent whenever the setting or the host's capability changes.
  useEffect(() => {
    if (!isDesktopHost()) return;
    bridge()?.request(enabled ? 'enable' : 'disable');
  }, [enabled, capability?.available]);

  return { enabled, capability, state };
}
