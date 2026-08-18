import React, { useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { WriteReview } from '../store/chatStore';

/**
 * In-chat review card for one proposed agent write: colored diff + Approve /
 * Reject. The agent's tool loop is BLOCKED on this decision host-side, so the
 * card is the safety mechanism — the diff must be honest and the buttons
 * unambiguous. Once decided, buttons collapse into a badge (the gate is
 * single-shot; a stale card after reload no-ops harmlessly).
 */

interface AgentWriteCardProps {
  review: WriteReview;
  onDecided: (id: string, decision: 'approved' | 'rejected') => void;
}

const KIND_LABEL: Record<WriteReview['kind'], string> = {
  edit: 'Edit',
  create: 'New file',
  delete: 'Delete',
  command: 'Command',
};

/** Collapsed by default once a review is already decided — only the still-pending
 *  card (or one just opened) needs its diff visible right away. */
const AgentWriteCard: React.FC<AgentWriteCardProps> = ({ review, onDecided }) => {
  const vscode = VSCodeAPI();
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState(!review.decision);

  const decide = (approved: boolean, scope: 'once' | 'session' = 'once') => {
    vscode.postMessage({
      type: MESSAGE_TYPES.AGENT_WRITE_DECISION,
      id: review.id,
      approved,
      scope,
      feedback: approved ? undefined : feedback.trim() || undefined,
    });
    onDecided(review.id, approved ? 'approved' : 'rejected');
  };

  const openInEditor = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.OPEN_FILE_IN_EDITOR, path: review.path });
  };

  return (
    <div className={`agent-write-card kind-${review.kind}`}>
      <div className='agent-write-header'>
        <button
          type='button'
          className='agent-write-collapse'
          aria-label={expanded ? 'Collapse diff' : 'Expand diff'}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
            <path d='M9 6L15 12L9 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </button>
        <span className={`agent-write-kind kind-${review.kind}`}>{KIND_LABEL[review.kind]}</span>
        <code className='agent-write-path'>{review.path}</code>
        {review.kind !== 'command' && (
          <button type='button' className='agent-write-open' aria-label='Open file in editor' title='Open file in editor' onClick={openInEditor}>
            <svg width='13' height='13' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
              <path d='M18 13V19C18 19.5304 17.7893 20.0391 17.4142 20.4142C17.0391 20.7893 16.5304 21 16 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V8C3 7.46957 3.21071 6.96086 3.58579 6.58579C3.96086 6.21071 4.46957 6 5 6H11' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
              <path d='M15 3H21V9' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
              <path d='M10 14L21 3' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </button>
        )}
        <span className='agent-write-stats'>
          {review.diff.added > 0 && <span className='stat-added'>+{review.diff.added}</span>}
          {review.diff.removed > 0 && <span className='stat-removed'>−{review.diff.removed}</span>}
        </span>
      </div>

      {expanded && (review.kind === 'command' ? (
        <pre className='agent-write-diff agent-command-text'>
          <div className='diff-line-context'>$ {review.command ?? review.summary}</div>
        </pre>
      ) : (
        review.diff.text && (
          <pre className='agent-write-diff'>
            {review.diff.text.split('\n').map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith('+') ? 'diff-line-added' : line.startsWith('-') ? 'diff-line-removed' : 'diff-line-context'
                }
              >
                {line || ' '}
              </div>
            ))}
          </pre>
        )
      ))}

      {review.decision ? (
        <div className={`agent-write-decision ${review.decision}`}>
          {review.decision === 'approved' ? '✓ Applied' : '✕ Rejected'}
        </div>
      ) : rejecting ? (
        <div className='agent-write-actions'>
          <input
            type='text'
            className='agent-write-feedback'
            placeholder='Why? (optional — sent to the agent)'
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && decide(false)}
            autoFocus
          />
          <button type='button' className='agent-write-reject' onClick={() => decide(false)}>
            Reject
          </button>
          <button type='button' className='agent-write-cancel' onClick={() => setRejecting(false)}>
            Back
          </button>
        </div>
      ) : (
        <div className='agent-write-actions'>
          <button type='button' className='agent-write-approve' onClick={() => decide(true)}>
            ✓ Approve
          </button>
          {review.kind === 'command' && (
            <button
              type='button'
              className='agent-write-reject-open'
              title='Run now and skip review for this exact command for the rest of the session'
              onClick={() => decide(true, 'session')}
            >
              ✓ Approve for session
            </button>
          )}
          <button type='button' className='agent-write-reject-open' onClick={() => setRejecting(true)}>
            ✕ Reject…
          </button>
        </div>
      )}
    </div>
  );
};

export default AgentWriteCard;
