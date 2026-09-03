import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { TurnSummary, useChatStore } from '../store/chatStore';

type ShipState =
  | { phase: 'idle' }
  | { phase: 'running'; requestId: string }
  | { phase: 'done'; branch: string; prUrl?: string; ticketCommented: boolean; warnings: string[] }
  | { phase: 'error'; error: string };

/**
 * End-of-turn changed-files bar, Antigravity-style: "1 file changed +2 −2"
 * with an expandable per-file list and a Review button that opens each file's
 * native original ⟷ current diff in the editor.
 */

interface FilesChangedBarProps {
  summary: TurnSummary;
  /** This turn's answer text — doubles as the PR body/ticket comment. */
  report: string;
}

const fileName = (p: string) => p.split('/').pop() || p;

const FilesChangedBar: React.FC<FilesChangedBarProps> = ({ summary, report }) => {
  const vscode = VSCodeAPI();
  const [expanded, setExpanded] = useState(false);
  const [ship, setShip] = useState<ShipState>({ phase: 'idle' });

  // Outcome of "Create PR" arrives as a host message correlated by requestId.
  useEffect(() => {
    if (ship.phase !== 'running') return;
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type !== MESSAGE_TYPES.AGENT_SHIP_DONE || m.requestId !== ship.requestId) return;
      setShip(
        m.ok
          ? { phase: 'done', branch: m.branch, prUrl: m.prUrl, ticketCommented: !!m.ticketCommented, warnings: m.warnings ?? [] }
          : { phase: 'error', error: m.error || 'Create PR failed.' }
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [ship]);

  const files = summary.filesChanged;
  if (!files.length) return null;

  const createPr = () => {
    const requestId = `ship-${Date.now().toString(36)}`;
    setShip({ phase: 'running', requestId });
    vscode.postMessage({
      type: MESSAGE_TYPES.AGENT_SHIP,
      sessionId: useChatStore.getState().currentSessionId,
      requestId,
      // Carried here (rather than relying solely on the host's in-memory
      // record of the last shippable turn) so "Create PR" still works after
      // an extension host restart — everything needed survives in this
      // persisted message's own turnSummary + content.
      shipInput: {
        ticketId: summary.ticketId,
        ticketType: summary.ticketType,
        title: summary.title,
        report,
        files: files.map((f) => f.path),
      },
    });
  };

  const totalAdded = files.reduce((n, f) => n + f.added, 0);
  const totalRemoved = files.reduce((n, f) => n + f.removed, 0);

  const openDiff = (path: string, kind: string) => {
    if (kind === 'delete') return; // nothing on disk to diff against
    vscode.postMessage({ type: MESSAGE_TYPES.OPEN_DIFF_IN_EDITOR, path });
  };

  const reviewAll = () => {
    files.forEach((f) => openDiff(f.path, f.kind));
  };

  return (
    <div className='files-changed-bar'>
      <div className='files-changed-header'>
        <button
          type='button'
          className='files-changed-toggle'
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <svg width='11' height='11' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
            <path d='M9 6L15 12L9 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
          <span className='files-changed-label'>
            {files.length} file{files.length === 1 ? '' : 's'} changed
          </span>
          <span className='files-changed-stats'>
            {totalAdded > 0 && <span className='stat-added'>+{totalAdded}</span>}
            {totalRemoved > 0 && <span className='stat-removed'>−{totalRemoved}</span>}
          </span>
        </button>
        <button type='button' className='files-changed-review' onClick={reviewAll}>
          Review
        </button>
        {summary.shippable && ship.phase !== 'done' && (
          <button
            type='button'
            className='files-changed-review files-changed-ship'
            onClick={createPr}
            disabled={ship.phase === 'running'}
            title={
              summary.ticketId
                ? `Branch, commit, push, open the pull-request page and post the report on #${summary.ticketId}`
                : 'Branch, commit, push and open the pull-request page'
            }
          >
            {ship.phase === 'running' ? 'Creating…' : 'Create PR'}
          </button>
        )}
      </div>
      {ship.phase === 'done' && (
        <div className='files-changed-ship-result'>
          <span className='stat-added'>✓</span> Pushed <code>{ship.branch}</code>
          {ship.prUrl && (
            <>
              {' · '}
              <a href={ship.prUrl} target='_blank' rel='noreferrer'>
                pull request
              </a>
            </>
          )}
          {ship.ticketCommented && summary.ticketId ? ` · report posted on #${summary.ticketId}` : ''}
          {ship.warnings.map((w, i) => (
            <div key={i} className='files-changed-ship-warning'>
              {w}
            </div>
          ))}
        </div>
      )}
      {ship.phase === 'error' && <div className='files-changed-ship-result files-changed-ship-warning'>{ship.error}</div>}
      {expanded && (
        <div className='files-changed-list'>
          {files.map((f) => (
            <button
              type='button'
              key={f.path}
              className={`files-changed-row${f.kind === 'delete' ? ' is-deleted' : ''}`}
              title={f.kind === 'delete' ? `${f.path} (deleted)` : `Open diff for ${f.path}`}
              onClick={() => openDiff(f.path, f.kind)}
            >
              <span className='files-changed-name'>{fileName(f.path)}</span>
              <span className='files-changed-path'>{f.path}</span>
              <span className='files-changed-stats'>
                {f.kind === 'delete' ? (
                  <span className='stat-removed'>deleted</span>
                ) : (
                  <>
                    {f.added > 0 && <span className='stat-added'>+{f.added}</span>}
                    {f.removed > 0 && <span className='stat-removed'>−{f.removed}</span>}
                  </>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default FilesChangedBar;
