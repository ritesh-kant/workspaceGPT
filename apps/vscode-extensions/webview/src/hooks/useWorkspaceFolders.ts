import { useEffect, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';

export interface WorkspaceFolders {
  /** The folder open in this window; '' when none. */
  current: string;
  recent: string[];
  home: string;
  /** Settings → Default folder; '' when unset. */
  defaultFolder: string;
  loaded: boolean;
}

const EMPTY: WorkspaceFolders = { current: '', recent: [], home: '', defaultFolder: '', loaded: false };

export const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** Same folder whatever the trailing separator. */
export const sameFolder = (a: string, b: string) => !!a && !!b && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '');

/**
 * The host's RECENT_FOLDERS answer, kept current: asked for on mount, and
 * re-sent by the host whenever the default folder changes.
 */
export function useWorkspaceFolders(): WorkspaceFolders {
  const [folders, setFolders] = useState<WorkspaceFolders>(EMPTY);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type !== MESSAGE_TYPES.RECENT_FOLDERS) return;
      setFolders({
        current: m.current ?? '',
        recent: Array.isArray(m.recent) ? m.recent : [],
        home: m.home ?? '',
        defaultFolder: m.defaultFolder ?? '',
        loaded: true,
      });
    };
    window.addEventListener('message', onMessage);
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.GET_RECENT_FOLDERS });
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return folders;
}
