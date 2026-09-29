import React, { useMemo } from 'react';
import { useChatStore } from '../store/chatStore';
import { hasShippableChanges, useChatChanges, useGitStatusStore } from '../store/gitStatusStore';

/**
 * The one "Create PR" control, living in the git status bar next to the branch
 * and diff it acts on. Offering it from several places at once left two
 * identical-looking buttons with different blast radii on screen together, so
 * the message card's per-turn copy is gone and this is the only one.
 *
 * It ships exactly what the bar shows. While this chat has recorded files
 * still uncommitted, that is those files and nothing else — never another
 * chat's or the user's own edits — ticket-aware, with the latest turn's
 * report as the PR body. Otherwise it is the whole working tree, which the
 * bar then labels as such (and the host's title prompt lists).
 */
const CreatePrButton: React.FC = () => {
  const status = useGitStatusStore((s) => s.status);
  const ship = useGitStatusStore((s) => s.ship);
  const createPr = useGitStatusStore((s) => s.createPr);
  const createPrForTurn = useGitStatusStore((s) => s.createPrForTurn);
  const messages = useChatStore((s) => s.messages);
  const sessionId = useChatStore((s) => s.currentSessionId);
  // Mid-run the turn's files are still being written: shipping now would
  // commit a half-made change, so wait for the run to finish.
  const runInProgress = useChatStore((s) => s.isLoading || s.isStreaming);
  const { recorded, changes } = useChatChanges();

  // Newest unshipped turn with changes: its ticket, title and report go on the PR.
  const turn = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.isUser || !m.turnSummary) continue;
      if (m.turnSummary.shipped) break; // everything before a ship went with it
      if (!m.turnSummary.shippable || !m.turnSummary.filesChanged.length) continue;
      return { summary: m.turnSummary, report: m.content };
    }
    return null;
  }, [messages]);

  // Visibility follows only "is there anything uncommitted", per git right
  // now: a transcript's shippable turn whose files were since restored or
  // committed outside the app is not something to ship.
  // Keying it off a 'done' ship instead would strand the button hidden, since
  // a turn ship's outcome is acknowledged on its card, not here.
  const treeDirty = hasShippableChanges(status);
  if (!treeDirty) return null;
  const shipsChat = !!turn && changes.files.length > 0;
  const n = changes.files.length;
  const others = changes.others;

  const running = ship.phase === 'running';
  const onClick = () => {
    if (shipsChat) {
      createPrForTurn(sessionId, {
        ticketId: turn.summary.ticketId,
        ticketType: turn.summary.ticketType,
        title: turn.summary.title,
        report: turn.report,
        files: changes.files,
        hasNewFiles: changes.files.some((f) => recorded.get(f) === 'create'),
      });
    } else {
      createPr();
    }
  };

  const leftOut = others > 0 ? ` (${others} other uncommitted file${others === 1 ? '' : 's'} left out)` : '';
  const title = shipsChat
    ? turn.summary.ticketId
      ? `Branch, commit, push this chat's ${n} file${n === 1 ? '' : 's'}${leftOut}, open the pull-request page and post the report on #${turn.summary.ticketId}`
      : `Branch, commit, push this chat's ${n} file${n === 1 ? '' : 's'}${leftOut} and open the pull-request page`
    : `Branch off ${status?.branch ?? 'HEAD'}, commit, push and open the pull-request page for everything uncommitted in the working tree, none of it made in this chat`;

  return (
    <button
      type='button'
      className='git-status-ship'
      onClick={onClick}
      disabled={running || runInProgress || (!shipsChat && !status?.branch)}
      title={runInProgress ? 'Available once the run finishes' : title}
    >
      {running ? 'Creating…' : 'Create PR'}
    </button>
  );
};

export default CreatePrButton;
