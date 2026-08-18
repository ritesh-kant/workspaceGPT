import React, { useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { TurnSummary } from '../store/chatStore';

/**
 * End-of-turn changed-files bar, Antigravity-style: "1 file changed +2 −2"
 * with an expandable per-file list and a Review button that opens each file's
 * native original ⟷ current diff in the editor.
 */

interface FilesChangedBarProps {
  summary: TurnSummary;
}

const fileName = (p: string) => p.split('/').pop() || p;

const FilesChangedBar: React.FC<FilesChangedBarProps> = ({ summary }) => {
  const vscode = VSCodeAPI();
  const [expanded, setExpanded] = useState(false);

  const files = summary.filesChanged;
  if (!files.length) return null;

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
          <span>
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
      </div>
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
