import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { WriteReview } from '../store/chatStore';
import { copyToClipboard } from '../utils/clipboard';

/**
 * In-chat review card for one proposed agent write: colored diff + Approve /
 * Reject. The agent's tool loop is BLOCKED on this decision host-side, so the
 * card is the safety mechanism — the diff must be honest and the buttons
 * unambiguous. Once decided, buttons collapse into a badge (the gate is
 * single-shot; the host answers a click on a dead gate with 'stopped').
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
  'confluence-edit': 'Confluence edit',
  'confluence-create': 'New Confluence page',
  question: 'Question',
};

const DECISION_LABEL: Record<NonNullable<WriteReview['decision']>, string> = {
  approved: '✓ Applied',
  rejected: '✕ Rejected',
  failed: '✕ Failed to apply',
  stopped: 'Not applied — run stopped',
};

/** Shared with the pinned review bar in App.tsx. */
export const REVIEW_KIND_LABEL = KIND_LABEL;

/** Collapsed by default once a review is already decided — only the still-pending
 *  card (or one just opened) needs its diff visible right away. */
const AgentWriteCard: React.FC<AgentWriteCardProps> = ({ review, onDecided }) => {
  const vscode = VSCodeAPI();
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState(!review.decision);

  // The decision arrives asynchronously (approve/reject click, or a
  // rehydrated history card resolving) — collapse the diff the moment it
  // does, instead of leaving it expanded forever alongside the Applied badge.
  useEffect(() => {
    if (review.decision) setExpanded(false);
  }, [review.decision]);

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

  const isConfluence = review.kind === 'confluence-edit' || review.kind === 'confluence-create';
  const openInEditor = () => {
    if (isConfluence) {
      if (review.url) vscode.postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: review.url });
      return;
    }
    vscode.postMessage({ type: MESSAGE_TYPES.OPEN_FILE_IN_EDITOR, path: review.path });
  };
  const openLabel = isConfluence
    ? review.kind === 'confluence-create' ? 'Open parent page in Confluence' : 'Open page in Confluence'
    : 'Open file in editor';

  const renderDecision = () => (
    <>
      {review.decision ? (
        <div className={`agent-write-decision ${review.decision}`}>
          {DECISION_LABEL[review.decision]}
        </div>
      ) : review.applying ? (
        // Approved, but "Applied" waits for the host to confirm the write.
        <div className='agent-write-decision applying'>Applying…</div>
      ) : rejecting ? (
        <div className='agent-write-actions' data-review-actions={review.id}>
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
        <div className='agent-write-actions' data-review-actions={review.id}>
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
    </>
  );

  if (review.kind === 'command') {
    const command = (review.command ?? review.summary ?? '').trim();
    const [bin, ...args] = command.split(/(\s+)/);
    return (
      <div className='agent-write-card kind-command' data-review-id={review.id}>
        <div className='code-block code-block--wrap'>
          <div className='code-block-header'>
            <button
              type='button'
              className='code-block-copy'
              title='Copy'
              aria-label='Copy'
              onClick={() => void copyToClipboard(command)}
            >
              <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><rect x='9' y='9' width='11' height='11' rx='2' /><path d='M5 15V6a2 2 0 0 1 2-2h9' /></svg>
            </button>
          </div>
          <pre><code className='agent-command-code'><span className='agent-command-bin'>{bin}</span>{args.join('')}</code></pre>
        </div>
        {renderDecision()}
      </div>
    );
  }

  return (
    <div className={`agent-write-card kind-${review.kind}`} data-review-id={review.id}>
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
        {(!isConfluence || !!review.url) && (
          <button type='button' className='agent-write-open' aria-label={openLabel} title={openLabel} onClick={openInEditor}>
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

      {expanded && (
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
      )}

      {renderDecision()}
    </div>
  );
};

export default AgentWriteCard;
