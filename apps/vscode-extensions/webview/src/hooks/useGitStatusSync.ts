import { useEffect } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { useGitStatusStore } from '../store/gitStatusStore';

const POLL_MS = 15_000;

/**
 * Keeps the git-status store fed. Call this ONCE, from App — the status bar
 * and the composer's Create PR button both read the store, and a poll loop
 * per consumer would mean a `git status` shell-out per consumer per tick.
 */
export function useGitStatusSync(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const vscode = VSCodeAPI();
    const requestStatus = () => vscode.postMessage({ type: MESSAGE_TYPES.GET_GIT_STATUS });

    requestStatus();
    const interval = setInterval(requestStatus, POLL_MS);

    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      const store = useGitStatusStore.getState();
      if (m?.type === MESSAGE_TYPES.GIT_STATUS) {
        store.setStatus({
          isRepo: !!m.isRepo,
          branch: m.branch,
          added: m.added ?? 0,
          removed: m.removed ?? 0,
          filesChanged: m.filesChanged ?? 0,
          hasRemote: !!m.hasRemote,
          prUrlTemplate: m.prUrlTemplate,
        });
      } else if (m?.type === MESSAGE_TYPES.AGENT_SHIP_ALL_DONE || m?.type === MESSAGE_TYPES.AGENT_SHIP_DONE) {
        // Both shapes land here: the composer's Create PR drives the
        // whole-tree ship and the per-turn one, and correlates either by
        // the requestId it sent.
        const prev = store.ship;
        if (prev.phase !== 'running' || m.requestId !== prev.requestId) return;
        const scope = prev.scope;
        store.setShip(
          m.cancelled
            ? { phase: 'idle' } // dismissed the title prompt
            : m.ok
              ? {
                  phase: 'done',
                  scope,
                  branch: m.branch,
                  prUrl: m.prUrl,
                  warnings: m.warnings ?? [],
                  ticketCommented: !!m.ticketCommented,
                  ticketId: m.ticketId,
                }
              : { phase: 'error', scope, error: m.error || 'Create PR failed.' }
        );
        // The tree is (likely) clean now — refresh so the diff stats catch up.
        setTimeout(requestStatus, 300);
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(interval);
      window.removeEventListener('message', onMessage);
    };
  }, [enabled]);
}
