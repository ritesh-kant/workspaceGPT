import React, { useMemo } from 'react';
import { useChatStore } from '../store/chatStore';
import { hasShippableChanges, useGitStatusStore } from '../store/gitStatusStore';

/**
 * The one "Create PR" control, living in the composer's bottom row beside the
 * other controls rather than inside a message card or the git status bar —
 * the action belongs with the things you *do*, and offering it from several
 * places at once left two identical-looking buttons with different blast
 * radii on screen together.
 *
 * It ships the latest shippable agent turn when there is one (ticket-aware:
 * the report becomes the PR body and is posted back on the work item), and
 * otherwise the whole uncommitted working tree.
 */
const CreatePrButton: React.FC = () => {
  const status = useGitStatusStore((s) => s.status);
  const ship = useGitStatusStore((s) => s.ship);
  const createPr = useGitStatusStore((s) => s.createPr);
  const createPrForTurn = useGitStatusStore((s) => s.createPrForTurn);
  const messages = useChatStore((s) => s.messages);
  const sessionId = useChatStore((s) => s.currentSessionId);

  // Newest turn that still has changes the host is holding ready to ship.
  const turn = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.isUser || !m.turnSummary?.shippable || !m.turnSummary.filesChanged.length) continue;
      return { summary: m.turnSummary, report: m.content };
    }
    return null;
  }, [messages]);

  // Visibility follows only "is there anything to ship": a shipped turn stops
  // being shippable and a shipped tree goes clean, so this retires itself.
  // Keying it off a 'done' ship instead would strand the button hidden, since
  // a turn ship's outcome is acknowledged on its card, not here.
  const treeDirty = hasShippableChanges(status);
  if (!turn && !treeDirty) return null;

  const running = ship.phase === 'running';
  const onClick = () => {
    if (turn) {
      const files = turn.summary.filesChanged;
      createPrForTurn(sessionId, {
        ticketId: turn.summary.ticketId,
        ticketType: turn.summary.ticketType,
        title: turn.summary.title,
        report: turn.report,
        files: files.map((f) => f.path),
        hasNewFiles: files.some((f) => f.kind === 'create'),
      });
    } else {
      createPr();
    }
  };

  const title = turn
    ? turn.summary.ticketId
      ? `Branch, commit, push this turn's ${turn.summary.filesChanged.length} file${turn.summary.filesChanged.length === 1 ? '' : 's'}, open the pull-request page and post the report on #${turn.summary.ticketId}`
      : `Branch, commit, push this turn's ${turn.summary.filesChanged.length} file${turn.summary.filesChanged.length === 1 ? '' : 's'} and open the pull-request page`
    : `Branch off ${status?.branch ?? 'HEAD'}, commit, push and open the pull-request page for everything currently uncommitted`;

  return (
    <button
      type='button'
      className='create-pr-chip'
      onClick={onClick}
      disabled={running || (!turn && !status?.branch)}
      title={title}
    >
      <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
        <path
          d='M6 3v12M6 21a3 3 0 1 0 0-6M18 21a3 3 0 1 0 0-6M18 15V9l-4-4M14 5h4v4'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
      <span>{running ? 'Creating…' : 'Create PR'}</span>
    </button>
  );
};

export default CreatePrButton;
