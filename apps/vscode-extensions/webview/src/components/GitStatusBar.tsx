import React, { useEffect, useRef, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';

interface GitStatus {
  isRepo: boolean;
  branch?: string;
  added: number;
  removed: number;
  filesChanged: number;
  hasRemote: boolean;
}

type ShipState =
  | { phase: 'idle' }
  | { phase: 'running'; requestId: string }
  | { phase: 'done'; branch: string; prUrl?: string; warnings: string[] }
  | { phase: 'error'; error: string };

const POLL_MS = 15_000;

/**
 * Always-on git status bar above the composer, Claude-Code-desktop-style:
 * current branch, the working tree's uncommitted diff stats, and a
 * "Create PR" split button that ships EVERYTHING dirty (not scoped to one
 * agent turn — see FilesChangedBar.tsx for the per-turn equivalent).
 */
const GitStatusBar: React.FC = () => {
  const vscode = VSCodeAPI();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [ship, setShip] = useState<ShipState>({ phase: 'idle' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);

  const requestStatus = () => vscode.postMessage({ type: MESSAGE_TYPES.GET_GIT_STATUS });

  useEffect(() => {
    requestStatus();
    const interval = setInterval(requestStatus, POLL_MS);
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.GIT_STATUS) {
        setStatus({
          isRepo: !!m.isRepo,
          branch: m.branch,
          added: m.added ?? 0,
          removed: m.removed ?? 0,
          filesChanged: m.filesChanged ?? 0,
          hasRemote: !!m.hasRemote,
        });
      } else if (m?.type === MESSAGE_TYPES.AGENT_SHIP_ALL_DONE) {
        setShip((prev) => {
          if (prev.phase !== 'running' || m.requestId !== prev.requestId) return prev;
          if (m.cancelled) return { phase: 'idle' }; // dismissed the title prompt
          return m.ok
            ? { phase: 'done', branch: m.branch, prUrl: m.prUrl, warnings: m.warnings ?? [] }
            : { phase: 'error', error: m.error || 'Create PR failed.' };
        });
        // Working tree is (likely) clean now — refresh so the bar can hide.
        setTimeout(requestStatus, 300);
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      clearInterval(interval);
      window.removeEventListener('message', onMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the split-button menu on outside click.
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  if (!status || !status.isRepo || status.filesChanged === 0) return null;

  const signature = `${status.branch}|${status.added}|${status.removed}|${status.filesChanged}`;
  if (dismissedSignature === signature) return null;

  const createPr = () => {
    const requestId = `ship-all-${Date.now().toString(36)}`;
    setShip({ phase: 'running', requestId });
    vscode.postMessage({ type: MESSAGE_TYPES.AGENT_SHIP_ALL, requestId });
  };

  const copyBranchName = () => {
    if (status.branch) navigator.clipboard?.writeText(status.branch).catch(() => undefined);
    setMenuOpen(false);
  };

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
          {status.branch || 'detached'}
        </span>
        {(status.added > 0 || status.removed > 0) && (
          <span className='git-status-stats'>
            {status.added > 0 && <span className='stat-added'>+{status.added}</span>}
            {status.removed > 0 && <span className='stat-removed'>−{status.removed}</span>}
          </span>
        )}
        <div className='git-status-actions'>
          {ship.phase !== 'done' && (
            <div className='git-status-ship-group' ref={menuRef}>
              <button
                type='button'
                className='git-status-ship'
                onClick={createPr}
                disabled={ship.phase === 'running' || !status.branch}
                title='Branch, commit, push and open the pull-request page for everything currently uncommitted'
              >
                {ship.phase === 'running' ? 'Creating…' : 'Create PR'}
              </button>
              <button
                type='button'
                className='git-status-ship-menu-toggle'
                onClick={() => setMenuOpen((v) => !v)}
                aria-label='More actions'
                aria-expanded={menuOpen}
              >
                <svg width='10' height='10' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                  <path d='M6 9l6 6 6-6' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                </svg>
              </button>
              {menuOpen && (
                <div className='git-status-ship-menu'>
                  <button type='button' onClick={copyBranchName}>
                    Copy branch name
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            type='button'
            className='git-status-dismiss'
            onClick={() => setDismissedSignature(signature)}
            aria-label='Dismiss'
          >
            <svg width='11' height='11' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
              <path d='M6 6l12 12M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
            </svg>
          </button>
        </div>
      </div>
      {ship.phase === 'done' && (
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
