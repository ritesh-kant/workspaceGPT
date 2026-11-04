import { useEffect, useRef } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { MAX_CI_FIX_ATTEMPTS, ciFixPrompt, commentKey, useCiStore, type CiSnapshot } from '../store/ciStore';
import { recordedChatFiles, useGitStatusStore } from '../store/gitStatusStore';
import { useChatStore } from '../store/chatStore';

// Checks in flight change within seconds-to-minutes; with nothing running the
// PR only moves when someone pushes or merges, which also triggers a refresh.
const FAST_MS = 30_000;
const SLOW_MS = 120_000;

/** Files the given turns changed that are still uncommitted — what a fix push commits. */
const chatUncommittedFiles = (messages: Parameters<typeof recordedChatFiles>[0]): string[] => {
  const recorded = recordedChatFiles(messages);
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
    // The PR this fix was started for: a fix that opens a new chat clears the snapshot (see below).
    let fixPr: CiSnapshot['pr'];
    let fixSubject = '';

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
      if (!snap.pr || ci.phase !== 'idle' || chat.isLoading || chat.isStreaming) return;
      // Review comments are unresolved until a person resolves them, so an
      // automatic fix takes only the ones it has not already tried.
      const comments = (snap.comments ?? []).filter((c) => manual || !ci.handledComments.includes(commentKey(c)));
      let log = snap.state === 'failed' ? snap.failureLog : undefined;
      if (!manual && snap.pr.sha === ci.handledSha) log = undefined;
      if (manual && snap.state === 'failed' && !log && !comments.length) {
        ci.setNote("Couldn't read the failing log, so there is nothing to fix from. Open the check's details link.");
        return;
      }
      if (!log && !comments.length) return;
      // Mid-run, checks still moving: wait rather than push under a running CI.
      if (!manual && snap.state === 'pending') return;
      if ((ci.attempts[snap.pr.number] ?? 0) >= MAX_CI_FIX_ATTEMPTS) {
        if (manual) ci.setNote(`Gave up after ${MAX_CI_FIX_ATTEMPTS} fix attempts — it is still not resolved.`);
        return;
      }
      ci.spendAttempt(snap.pr.number, snap.pr.sha, comments.map(commentKey));
      ci.setNote(null);
      fixPr = snap.pr;
      fixSubject = log ? (comments.length ? `fix: address CI failure and review comments on #${snap.pr.number}` : `fix: address failing CI on #${snap.pr.number}`) : `fix: address review comments on #${snap.pr.number}`;
      sendFixRef.current(ciFixPrompt(snap.pr, log, comments));
      // Read after sending: from the new-chat screen the send is what gives the chat its id.
      ci.setPhase('fixing', useChatStore.getState().currentSessionId);
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
        const snap: CiSnapshot = { state: m.state, reason: m.reason, pr: m.pr, checks: m.checks ?? [], comments: m.comments, failureLog: m.failureLog };
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
      const pr = fixPr ?? ci.snapshot?.pr;
      if (!pr || ci.fixSessionId !== state.currentSessionId) {
        ci.setPhase('idle');
        return;
      }
      // Claimed now, not in the timeout: a run's end can land as two loading→idle
      // updates inside 400ms, and each would otherwise push the same fix.
      ci.setPhase('pushing', ci.fixSessionId);
      // Next tick: the run's last file records land with the same update.
      setTimeout(() => {
        // Stopped, errored or never sent: the fix turn posts no rollup, and
        // nothing the user stopped is pushed to the PR.
        const msgs = useChatStore.getState().messages;
        const fixPrompt = msgs.map((m) => m.isUser).lastIndexOf(true);
        if (!msgs.slice(fixPrompt + 1).some((m) => m.turnSummary)) {
          ci.setPhase('idle');
          ci.setNote('The fix run did not finish, so nothing was pushed.');
          return;
        }
        // Only what the fix turn changed: earlier unshipped work in this chat is not part of the fix.
        const files = chatUncommittedFiles(msgs.slice(fixPrompt + 1));
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
          subject: fixSubject || `fix: address failing CI on #${pr.number}`,
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
