import React from 'react';
import { hasShippableChanges, statusSignature, useChatChanges, useGitStatusStore } from '../store/gitStatusStore';
import CreatePrButton from './CreatePrButton';

/**
 * Always-on git status bar above the composer, Claude-Code-desktop-style:
 * current branch and uncommitted diff stats, scoped to the chat on screen.
 * Chats share one working tree, so the bar names its scope: "this chat" (its
 * recorded, still-uncommitted files, plus a count of the others it leaves
 * out) or, when this chat has none, "working tree". Hidden when clean.
 *
 * Carries the one "Create PR" (CreatePrButton.tsx), sitting with the branch
 * and diff it acts on. The bar stays mounted while a ship result is worth
 * reading, so the pushed branch and its pull-request link survive the tree
 * going clean underneath it.
 */
const GitStatusBar: React.FC = () => {
  const status = useGitStatusStore((s) => s.status);
  const ship = useGitStatusStore((s) => s.ship);
  const dismissedSignature = useGitStatusStore((s) => s.dismissedSignature);
  const dismiss = useGitStatusStore((s) => s.dismiss);
  const setShip = useGitStatusStore((s) => s.setShip);
  // One scope at a time, always named: this chat's recorded files while any
  // are uncommitted (exactly what Create PR ships), otherwise the working
  // tree, none of which this chat changed.
  const { changes } = useChatChanges();
  const ownScope = changes.files.length > 0;
  const shown = ownScope
    ? { files: changes.files.length, added: changes.added, removed: changes.removed }
    : { files: status?.filesChanged ?? 0, added: status?.added ?? 0, removed: status?.removed ?? 0 };

  const signature = status ? statusSignature(status) : '';
  const showChanges = hasShippableChanges(status) && dismissedSignature !== signature;
  // A turn ship already reports itself on its message card; announcing it here
  // as well just says the same thing twice, one above the other.
  const showResult = (ship.phase === 'done' && ship.scope === 'tree') || ship.phase === 'error';
  if (!showChanges && !showResult) return null;

  // One X for whichever the bar is currently carrying: an outcome to
  // acknowledge takes precedence over the diff it came from.
  const onDismiss = () => (showResult ? setShip({ phase: 'idle' }) : dismiss(signature));

  return (
    <div className='git-status-bar'>
      <div className='git-status-row'>
        <span className='git-status-branch' title='Current branch'>
          <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
            <path
              d='M6 3v12M18 9a3 3 0 1 0-3-3M6 21a3 3 0 1 0 0-6M9 6a9 9 0 0 0 9 9'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            />
          </svg>
          {status?.branch || 'detached'}
        </span>
        {showChanges && (
          <span
            className='git-status-stats'
            title={
              ownScope
                ? `Uncommitted changes this chat made (${shown.files} file${shown.files === 1 ? '' : 's'}): what Create PR commits`
                : 'Uncommitted changes in the working tree, none made in this chat (another chat or your own edits): Create PR commits all of them'
            }
          >
            <span className='git-status-stats-scope'>{ownScope ? 'this chat' : 'working tree'}</span>
            {shown.added === 0 && shown.removed === 0 ? (
              // New files only: git reports no insertions for a path it has
              // never seen, so the file count is all there is to say.
              <span className='git-status-stats-count'>
                {shown.files} file{shown.files === 1 ? '' : 's'}
              </span>
            ) : (
              <>
                {shown.added > 0 && <span className='stat-added'>+{shown.added}</span>}
                {shown.removed > 0 && <span className='stat-removed'>−{shown.removed}</span>}
              </>
            )}
            {ownScope && changes.others > 0 && (
              <span
                className='git-status-stats-others'
                title={`${changes.others} other uncommitted file${changes.others === 1 ? '' : 's'}, from another chat or your own edits: not included in Create PR`}
              >
                · {changes.others} other file{changes.others === 1 ? '' : 's'}
              </span>
            )}
          </span>
        )}
        <div className='git-status-actions'>
          <CreatePrButton />
          <button type='button' className='git-status-dismiss' onClick={onDismiss} aria-label='Dismiss'>
            <svg width='11' height='11' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
              <path d='M6 6l12 12M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            </svg>
          </button>
        </div>
      </div>
      {ship.phase === 'done' && ship.scope === 'tree' && (
        <div className='git-status-ship-result'>
          {ship.pushed ? (
            <>
              <span className='stat-added'>✓</span> Pushed <code>{ship.branch}</code>
            </>
          ) : (
            <>
              Committed locally on <code>{ship.branch}</code> (not pushed)
            </>
          )}
          {ship.prUrl && (
            <>
              {' · '}
              <a href={ship.prUrl} target='_blank' rel='noreferrer'>
                pull request
              </a>
            </>
          )}
          {ship.ticketCommented && ship.ticketId ? ` · report posted on #${ship.ticketId}` : ''}
          {ship.baseBranch && (
            <>
              {' · '}you're now on it (was <code>{ship.baseBranch}</code>)
            </>
          )}
          {ship.warnings.map((w, i) => (
            <div key={i} className='git-status-ship-warning'>
              {w}
            </div>
          ))}
        </div>
      )}
      {ship.phase === 'error' && <div className='git-status-ship-result git-status-ship-warning'>{ship.error}</div>}
    </div>
  );
};

export default GitStatusBar;
