import { useEffect } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { recordedChatFiles, useGitStatusStore } from '../store/gitStatusStore';
import { useChatStore } from '../store/chatStore';

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
    // Every request names the on-screen chat's recorded files, so the reply
    // says which of them are still uncommitted (the bar's "this chat" scope).
    const recordedPaths = () => [...recordedChatFiles(useChatStore.getState().messages).keys()];
    const recordedKey = () => recordedPaths().join('\n');
    const requestStatus = () => vscode.postMessage({ type: MESSAGE_TYPES.GET_GIT_STATUS, paths: recordedPaths() });
    // Several triggers can fire together (focus + visibility, a run ending as
    // its summary lands); they share one request.
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(requestStatus, 150);
    };

    requestStatus();
    const interval = setInterval(requestStatus, POLL_MS);

    // Beyond the poll, refresh the moment the bar can be wrong: the user
    // comes back to the window (they may have run git in a terminal), the
    // chat on screen changes, a run in it ends, or its recorded files change.
    // File changes on disk are pushed by the host's watcher.
    const onVisible = () => document.visibilityState === 'visible' && refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    let lastKey = recordedKey();
    const unsubscribeChat = useChatStore.subscribe((state, prev) => {
      const runEnded = (prev.isLoading || prev.isStreaming) && !state.isLoading && !state.isStreaming;
      const key = state.messages !== prev.messages ? recordedKey() : lastKey;
      if (state.currentSessionId !== prev.currentSessionId || runEnded || key !== lastKey) refresh();
      lastKey = key;
    });

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
          pathStats: Array.isArray(m.pathStats) ? m.pathStats : undefined,
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
                  baseBranch: m.baseBranch,
                  pushed: !!m.pushed,
                  prUrl: m.prUrl,
                  warnings: m.warnings ?? [],
                  ticketCommented: !!m.ticketCommented,
                  ticketId: m.ticketId,
                }
              : { phase: 'error', scope, error: m.error || 'Create PR failed.' }
        );
        // The tree is (likely) clean now — refresh so the diff stats catch up.
        setTimeout(requestStatus, 300);
      } else if (m?.type === MESSAGE_TYPES.AGENT_REVERT_DONE) {
        // An Undo rewrote files — don't show the pre-undo stats until the next poll.
        requestStatus();
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(interval);
      clearTimeout(refreshTimer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribeChat();
    };
  }, [enabled]);
}
