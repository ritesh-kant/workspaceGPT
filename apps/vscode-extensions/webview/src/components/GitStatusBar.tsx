import React from 'react';
import { hasShippableChanges, statusSignature, useGitStatusStore } from '../store/gitStatusStore';

/**
 * Always-on git status bar above the composer, Claude-Code-desktop-style:
 * current branch and the working tree's uncommitted diff stats.
 *
 * State only — the "Create PR" action that used to live here now sits in the
 * composer's control row (CreatePrButton.tsx), beside the other controls.
 * The bar stays mounted while a ship result is worth reading, so the pushed
 * branch and its pull-request link survive the tree going clean underneath it.
 */
const GitStatusBar: React.FC = () => {
  const status = useGitStatusStore((s) => s.status);
  const ship = useGitStatusStore((s) => s.ship);
  const dismissedSignature = useGitStatusStore((s) => s.dismissedSignature);
  const dismiss = useGitStatusStore((s) => s.dismiss);
  const setShip = useGitStatusStore((s) => s.setShip);

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
          <span className='git-status-stats' title='Uncommitted changes across the whole working tree, not just the last turn'>
            <span className='git-status-stats-scope'>working tree</span>
            {status.added === 0 && status.removed === 0 ? (
              // New files only: git reports no insertions for a path it has
              // never seen, so the file count is all there is to say.
              <span className='git-status-stats-count'>
                {status.filesChanged} file{status.filesChanged === 1 ? '' : 's'}
              </span>
            ) : (
              <>
                {status.added > 0 && <span className='stat-added'>+{status.added}</span>}
                {status.removed > 0 && <span className='stat-removed'>−{status.removed}</span>}
              </>
            )}
          </span>
        )}
        <div className='git-status-actions'>
          <button type='button' className='git-status-dismiss' onClick={onDismiss} aria-label='Dismiss'>
            <svg width='11' height='11' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
              <path d='M6 6l12 12M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            </svg>
          </button>
        </div>
      </div>
      {ship.phase === 'done' && ship.scope === 'tree' && (
        <div className='git-status-ship-result'>
          <span className='stat-added'>✓</span> Pushed <code>{ship.branch}</code>
          {ship.prUrl && (
            <>
              {' · '}
              <a href={ship.prUrl} target='_blank' rel='noreferrer'>
                pull request
              </a>
            </>
          )}
          {ship.ticketCommented && ship.ticketId ? ` · report posted on #${ship.ticketId}` : ''}
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
