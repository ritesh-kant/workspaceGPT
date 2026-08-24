import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import CodeBlock from './CodeBlock';
import AgentTimeline from './AgentTimeline';
import FilesChangedBar from './FilesChangedBar';
import InlineFileRef from './InlineFileRef';
import { parseFileRef } from '../utils/fileRefs';
import { AgentStep, TurnSummary } from '../store/chatStore';
import type { ChatAttachment } from '../constants';

type InlineCodeProps = React.ComponentPropsWithoutRef<'code'>;

/**
 * react-markdown's `code` renderer. Fenced code blocks get a `language-*`
 * className from rehype-highlight — those render as plain `<code>` (the
 * highlighting spans are already inside `children`). Inline code with no
 * className is checked against `parseFileRef`: a recognized file path (e.g.
 * `terraform/lambda.tf:L69-L106`) renders as a clickable pill instead of a
 * dead code span — mirrors Antigravity-style file citations.
 */
const InlineCode: React.FC<InlineCodeProps> = ({ className, children, ...rest }) => {
  if (className) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  const text = typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : '';
  const fileRef = parseFileRef(text);
  if (fileRef) return <InlineFileRef text={text} fileRef={fileRef} />;
  return (
    <code {...rest}>{children}</code>
  );
};

/** "16:21, 13/07/2026" — matches the format shown in Antigravity's message footer. */
const formatTimestamp = (ts: number): string => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};

interface ChatMessageProps {
  content: string;
  isUser: boolean;
  isError?: boolean;
  /** Files/images the user attached to this message. */
  attachments?: ChatAttachment[];
  /** Tool-exploration steps taken before this answer — rendered collapsed above it. */
  agentSteps?: (AgentStep | string)[];
  /** Duration + files-changed rollup for the agent turn that produced this answer. */
  turnSummary?: TurnSummary;
  /** When this message was sent — shown in the hover-revealed footer for user messages. */
  timestamp?: number;
  /** Checkpoint to hard-reset to if the user undoes this turn's changes; absent when the turn made none. */
  checkpointSha?: string;
  /** True while a revert to this message's checkpoint is in flight. */
  isReverting?: boolean;
  onUndo?: (sha: string) => void;
  /** Present when the turn this message triggered errored out — resends it. */
  onRetry?: () => void;
  /**
   * Rewrite this user message and re-ask from here. Absent while a run is in
   * flight (forking a live conversation would race the answer being streamed).
   */
  onEdit?: (newContent: string) => void;
  /** Fired when this bubble enters/leaves edit mode so the parent can dim the rest of the chat. */
  onEditingChange?: (editing: boolean) => void;
  /** Thumbs up/down on this assistant response — the satisfaction signal. */
  onFeedback?: (rating: 'up' | 'down') => void;
}

const ChatMessage: React.FC<ChatMessageProps> = ({
  content,
  isUser,
  isError,
  attachments,
  agentSteps,
  turnSummary,
  timestamp,
  checkpointSha,
  isReverting,
  onUndo,
  onRetry,
  onEdit,
  onEditingChange,
  onFeedback,
}) => {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const isEditing = draft !== null;
  const canSend = !!(draft ?? '').trim();

  const autosizeEdit = () => {
    const el = editRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  useEffect(() => {
    onEditingChange?.(isEditing);
    return () => onEditingChange?.(false);
  }, [isEditing, onEditingChange]);

  useEffect(() => {
    if (!isEditing) return;
    autosizeEdit();
    const el = editRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [isEditing]);

  const commitEdit = () => {
    const next = (draft ?? '').trim();
    setDraft(null);
    // An unchanged (or emptied) draft is a no-op — don't re-run the turn.
    if (!next || next === content.trim()) return;
    onEdit?.(next);
  };

  const onEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null);
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked in some webview contexts — silently skip.
    }
  };

  const rateMessage = (rating: 'up' | 'down') => {
    if (feedback === rating) return;
    setFeedback(rating);
    onFeedback?.(rating);
  };

  return (
    <div className={`message ${isError ? 'error-message' : isUser ? 'user-message' : 'assistant-message'}${isEditing ? ' user-message--editing' : ''}`}>
      {isUser ? (
        isEditing ? (
          <div className="message-edit">
            <textarea
              ref={editRef}
              className="message-edit-input"
              value={draft ?? ''}
              onChange={(e) => {
                setDraft(e.target.value);
                requestAnimationFrame(autosizeEdit);
              }}
              onKeyDown={onEditKeyDown}
              rows={1}
              aria-label="Edit message"
            />
            <div className="message-edit-toolbar">
              <button type="button" className="message-edit-cancel" onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="message-edit-send"
                onClick={commitEdit}
                disabled={!canSend}
                title="Send"
                aria-label="Send"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5" />
                  <path d="M5 12l7-7 7 7" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
        <>
          {attachments && attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((att, i) =>
                att.kind === 'image' ? (
                  <img
                    key={`${att.name}-${i}`}
                    src={att.content}
                    alt={att.name}
                    title={att.name}
                    className="message-attachment-image"
                  />
                ) : (
                  <span key={`${att.name}-${i}`} className="message-attachment-file" title={att.name}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                    {att.name}
                  </span>
                )
              )}
            </div>
          )}
          {content && <div className="message-content">{content}</div>}
          <div className="user-message-meta">
            {timestamp && <span className="user-message-timestamp">{formatTimestamp(timestamp)}</span>}
            {onEdit && !isEditing && (
              <button
                type="button"
                className="user-message-icon-button"
                onClick={() => setDraft(content)}
                title="Edit and re-ask from here"
                aria-label="Edit message"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="user-message-icon-button"
              onClick={copyMessage}
              title={copied ? 'Copied' : 'Copy message'}
              aria-label="Copy message"
            >
              {copied ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
            {checkpointSha && onUndo && (
              <button
                type="button"
                className="user-message-icon-button"
                onClick={() => onUndo(checkpointSha)}
                disabled={isReverting}
                title="Undo changes up to this point"
                aria-label="Undo changes up to this point"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 14 4 9 9 4" />
                  <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                </svg>
              </button>
            )}
            {onRetry && (
              <button
                type="button"
                className="user-message-icon-button"
                onClick={onRetry}
                title="Retry"
                aria-label="Retry"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            )}
          </div>
        </>
        )
      ) : (
        <>
          {agentSteps && agentSteps.length > 0 && (
            <AgentTimeline steps={agentSteps} durationMs={turnSummary?.durationMs} />
          )}
          <div className="message-content markdown-content">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{ pre: CodeBlock, code: InlineCode }}
            >
              {content}
            </ReactMarkdown>
          </div>
          {turnSummary && turnSummary.filesChanged.length > 0 && (
            <FilesChangedBar summary={turnSummary} />
          )}
          {!isError && (
            <>
              <div className="message-feedback">
                <button
                  type="button"
                  className={`message-feedback-button${feedback === 'up' ? ' message-feedback-button--active' : ''}`}
                  onClick={() => rateMessage('up')}
                  disabled={feedback === 'up'}
                  title="Good response"
                  aria-label="Good response"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`message-feedback-button${feedback === 'down' ? ' message-feedback-button--active' : ''}`}
                  onClick={() => rateMessage('down')}
                  disabled={feedback === 'down'}
                  title="Bad response"
                  aria-label="Bad response"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
                  </svg>
                </button>
              </div>
              <button
                type='button'
                className='message-copy-button'
                onClick={copyMessage}
                aria-label='Copy response'
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default ChatMessage;
