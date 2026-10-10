import { useEffect, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';

/**
 * Whether a code host (GitHub, GitLab, Bitbucket) is usable: connected in Settings, or
 * GitHub reachable through the GitHub CLI's own sign-in.
 * null until the host has answered, so a view never flashes "Connect" at
 * someone who is already connected. Every mounted user updates together when
 * the Settings card connects or disconnects.
 */
export function useCodeHostConnected(): boolean | null {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === MESSAGE_TYPES.CODEHOST_STATUS) setConnected((event.data.connections ?? []).length > 0 || !!event.data.detected);
    };
    window.addEventListener('message', onMessage);
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.CODEHOST_GET_STATUS });
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return connected;
}
