import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import CodeBlock from './CodeBlock';
import AgentTimeline from './AgentTimeline';
import FilesChangedBar from './FilesChangedBar';
import InlineFileRef from './InlineFileRef';
import { parseFileRef } from '../utils/fileRefs';
import { AgentStep, TurnSummary } from '../store/chatStore';

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
}

const ChatMessage: React.FC<ChatMessageProps> = ({
  content,
  isUser,
  isError,
  agentSteps,
  turnSummary,
  timestamp,
  checkpointSha,
  isReverting,
  onUndo,
  onRetry,
}) => {
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can be blocked in some webview contexts — silently skip.
    }
  };

  return (
    <div className={`message ${isError ? 'error-message' : isUser ? 'user-message' : 'assistant-message'}`}>
      {isUser ? (
        <>
          <div className="message-content">{content}</div>
          <div className="user-message-meta">
            {timestamp && <span className="user-message-timestamp">{formatTimestamp(timestamp)}</span>}
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
            <button
              type='button'
              className='message-copy-button'
              onClick={copyMessage}
              aria-label='Copy response'
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default ChatMessage;
