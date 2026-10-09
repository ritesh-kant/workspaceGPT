import { useEffect, useRef } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { MAX_CI_FIX_ATTEMPTS, ciFixPrompt, useCiStore, type CiSnapshot } from '../store/ciStore';
import { recordedChatFiles, useGitStatusStore } from '../store/gitStatusStore';
import { useChatStore } from '../store/chatStore';

// Checks in flight change within seconds-to-minutes; with nothing running the
// PR only moves when someone pushes or merges, which also triggers a refresh.
const FAST_MS = 30_000;
const SLOW_MS = 120_000;

/** Files the on-screen chat changed that are still uncommitted — what a fix push commits. */
const chatUncommittedFiles = (): string[] => {
  const recorded = recordedChatFiles(useChatStore.getState().messages);
  return (useGitStatusStore.getState().status?.pathStats ?? []).map((p) => p.path).filter((p) => recorded.has(p));
};

/**
 * Keeps the CI store fed and runs the fix cycle. Call ONCE, from App.
 *
 * Cycle: checks fail (and the user turned Auto-fix on, or clicked Fix) → one
 * ordinary agent turn with the failing log (`sendFix`, the same send path a
 * typed message takes) → when that run ends, the host commits the chat's
 * changed files to the PR's branch and pushes → CI re-runs → repeat, up to
 * MAX_CI_FIX_ATTEMPTS per PR, never twice for the same failing commit.
 */
export function useCiSync(enabled: boolean, sendFix: (prompt: string) => void): { fixNow: () => void } {
  const sendFixRef = useRef(sendFix);
  sendFixRef.current = sendFix;
  const startFixRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) return;
    const vscode = VSCodeAPI();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const request = () => vscode.postMessage({ type: MESSAGE_TYPES.CI_GET_STATUS, sessionId: useChatStore.getState().currentSessionId });
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (disposed) return;
        request();
      }, ms);
    };

    const startFix = (snap: CiSnapshot, manual: boolean) => {
      const ci = useCiStore.getState();
      const chat = useChatStore.getState();
      if (snap.state !== 'failed' || !snap.pr || !snap.failureLog || ci.phase !== 'idle' || chat.isLoading || chat.isStreaming) return;
      if (!manual && (ci.handledSha === snap.pr.sha || (ci.attempts[snap.pr.number] ?? 0) >= MAX_CI_FIX_ATTEMPTS)) return;
      if ((ci.attempts[snap.pr.number] ?? 0) >= MAX_CI_FIX_ATTEMPTS) {
        ci.setNote(`Gave up after ${MAX_CI_FIX_ATTEMPTS} fix attempts — CI is still failing.`);
        return;
      }
      ci.spendAttempt(snap.pr.number, snap.pr.sha);
      ci.setNote(null);
      ci.setPhase('fixing', chat.currentSessionId);
      sendFixRef.current(ciFixPrompt(snap.pr, snap.failureLog));
    };
    startFixRef.current = () => {
      const snap = useCiStore.getState().snapshot;
      if (snap) startFix(snap, true);
    };

    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      const ci = useCiStore.getState();
      if (m?.type === MESSAGE_TYPES.CI_STATUS) {
        if (m.sessionId !== useChatStore.getState().currentSessionId) return; // reply for a chat since left
        const snap: CiSnapshot = { state: m.state, reason: m.reason, pr: m.pr, checks: m.checks ?? [], failureLog: m.failureLog };
        ci.setSnapshot(snap);
        schedule(snap.state === 'pending' || ci.phase !== 'idle' ? FAST_MS : SLOW_MS);
        if (ci.autoFix) startFix(snap, false);
      } else if (m?.type === MESSAGE_TYPES.CI_PUSH_FIX_DONE) {
        ci.setPhase('idle');
        ci.setNote(m.ok ? 'Pushed a fix — waiting for CI to re-run.' : `Could not push the fix: ${m.error ?? 'unknown error'}`);
        schedule(m.ok ? 8_000 : SLOW_MS);
      } else if (m?.type === MESSAGE_TYPES.AGENT_SHIP_ALL_DONE || m?.type === MESSAGE_TYPES.AGENT_SHIP_DONE) {
        // A PR was just created: look for it soon (its checks take a moment to register).
        schedule(6_000);
      }
    };
    window.addEventListener('message', onMessage);

    // The fix run ended: push what it changed, to the PR's own branch.
    const unsubscribe = useChatStore.subscribe((state, prev) => {
      const ci = useCiStore.getState();
      const ended = (prev.isLoading || prev.isStreaming) && !state.isLoading && !state.isStreaming;
      if (!ended || ci.phase !== 'fixing') return;
      const pr = ci.snapshot?.pr;
      if (!pr || ci.fixSessionId !== state.currentSessionId) {
        ci.setPhase('idle');
        return;
      }
      // Next tick: the run's last file records land with the same update.
      setTimeout(() => {
        const files = chatUncommittedFiles();
        if (!files.length) {
          ci.setPhase('idle');
          ci.setNote('The agent finished without changing any files, so there is nothing to push.');
          return;
        }
        ci.setPhase('pushing', ci.fixSessionId);
        vscode.postMessage({
          type: MESSAGE_TYPES.CI_PUSH_FIX,
          sessionId: state.currentSessionId,
          requestId: `ci-${Date.now().toString(36)}`,
          files,
          branch: pr.branch,
          subject: `fix: address failing CI on #${pr.number}`,
        });
      }, 400);
    });

    const onVisible = () => document.visibilityState === 'visible' && request();
    window.addEventListener('focus', request);
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribeSession = useChatStore.subscribe((state, prev) => {
      if (state.currentSessionId !== prev.currentSessionId) {
        useCiStore.getState().setSnapshot(null);
        request();
      }
    });
    request();

    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', request);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
      unsubscribeSession();
    };
  }, [enabled]);

  return { fixNow: () => startFixRef.current() };
}
