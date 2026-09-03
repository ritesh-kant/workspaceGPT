import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import CodeBlock from './CodeBlock';
import AgentTimeline from './AgentTimeline';
import FilesChangedBar from './FilesChangedBar';
import InlineFileRef from './InlineFileRef';
import { parseFileRef } from '../utils/fileRefs';
import { adoWorkItemUrl, linkifyTicketIds } from '../utils/ticketRefs';
import { useSettingsStore } from '../store';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { AgentStep, TurnSummary } from '../store/chatStore';
import type { ChatAttachment } from '../constants';
import { copyToClipboard } from '../utils/clipboard';

type InlineCodeProps = React.ComponentPropsWithoutRef<'code'>;

/**
 * Links in model prose (and the ticket links this component injects) open in
 * the user's browser through the host, which validates the scheme. An in-panel
 * navigation would replace the chat itself, so the default action is always
 * suppressed. A ticket link renders as a pill, matching file citations.
 */
type AnchorProps = React.ComponentPropsWithoutRef<'a'> & ExtraProps;
const ChatLink: React.FC<AnchorProps> = ({ href, children, className, node: _node, ...rest }) => {
  const vscode = VSCodeAPI();
  const isTicket = /\/_workitems\/edit\/\d+/.test(href ?? '');
  return (
    <a
      {...rest}
      href={href}
      className={[className, isTicket ? 'ticket-ref' : ''].filter(Boolean).join(' ') || undefined}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) vscode.postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: href });
      }}
    >
      {children}
    </a>
  );
};

/** Plain text of a hast subtree — react-markdown hands each renderer its `node`. */
function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: unknown; children?: unknown[] };
  if (n.type === 'text') return typeof n.value === 'string' ? n.value : '';
  return Array.isArray(n.children) ? n.children.map(hastText).join('') : '';
}

const LEADING_EMOJI_RE = /^\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)+/u;

/**
 * The status heading that opens an agent report (see FINAL_REPORT_FORMAT in
 * promptTemplates.ts). Rendered as a coloured banner instead of a bare H2 so
 * the outcome is readable at a glance in the side panel. Anything that isn't a
 * status heading falls through to a normal <h2>.
 */
type ReportStatusKind = 'ok' | 'warn' | 'blocked' | 'neutral';
function reportStatusKind(text: string): ReportStatusKind | null {
  const t = text.replace(LEADING_EMOJI_RE, '').trim().toLowerCase();
  if (/^(no change (is )?needed|nothing to change|already (fixed|implemented|resolved))\b/.test(t)) return 'neutral';
  if (/^(blocked|cannot proceed|not done|failed)\b/.test(t)) return 'blocked';
  if (/^(partially|partial|incomplete|step limit|budget)\b/.test(t)) return 'warn';
  if (/^(done|complete|completed|fixed|implemented|resolved|shipped|success)\b/.test(t)) return 'ok';
  return null;
}

const STATUS_ICON: Record<ReportStatusKind, React.ReactNode> = {
  ok: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="8 12.5 11 15.5 16 9.5" />
    </svg>
  ),
  warn: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
    </svg>
  ),
  blocked: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
    </svg>
  ),
  neutral: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ),
};

/** Drop the leading emoji from the first text child — the banner draws its own icon. */
function stripLeadingEmoji(children: React.ReactNode): React.ReactNode {
  const arr = React.Children.toArray(children);
  if (arr.length && typeof arr[0] === 'string') arr[0] = (arr[0] as string).replace(LEADING_EMOJI_RE, '');
  return arr;
}

type H2Props = React.ComponentPropsWithoutRef<'h2'> & ExtraProps;
const ReportH2: React.FC<H2Props> = ({ node, children, ...rest }) => {
  const kind = reportStatusKind(hastText(node));
  if (!kind) return <h2 {...rest}>{children}</h2>;
  return (
    <div className={`report-status report-status--${kind}`} role="heading" aria-level={2}>
      <span className="report-status-icon" aria-hidden="true">{STATUS_ICON[kind]}</span>
      <span className="report-status-text">{stripLeadingEmoji(children)}</span>
    </div>
  );
};

const REPORT_SECTION_RE = /^(acceptance criteria|changes|files changed|verification|notes|assumptions|out of scope)\b/i;
type H3Props = React.ComponentPropsWithoutRef<'h3'> & ExtraProps;
const ReportH3: React.FC<H3Props> = ({ node, children, className, ...rest }) => {
  const isSection = REPORT_SECTION_RE.test(hastText(node).replace(LEADING_EMOJI_RE, '').trim());
  return (
    <h3 className={[className, isSection ? 'report-section-title' : ''].filter(Boolean).join(' ') || undefined} {...rest}>
      {children}
    </h3>
  );
};

/** A verdict cell ("✅ Met", "Not met", "Could not verify", "pass") → coloured badge. */
const VERDICT_RE = /^(met|passed?|pass|ok|yes|done|not met|unmet|failed?|fail|no|could not verify|couldn'?t verify|unverified|not verified|partially met|partial)$/i;
function verdictKind(raw: string): 'met' | 'notmet' | 'unverified' | 'partial' | null {
  const t = raw.replace(LEADING_EMOJI_RE, '').trim().replace(/\s+/g, ' ');
  if (!VERDICT_RE.test(t)) return null;
  const l = t.toLowerCase();
  if (/^(not met|unmet|failed?|fail|no)$/.test(l)) return 'notmet';
  if (/verif/.test(l)) return 'unverified';
  if (/partial/.test(l)) return 'partial';
  return 'met';
}
const VERDICT_LABEL: Record<NonNullable<ReturnType<typeof verdictKind>>, string> = {
  met: 'Met',
  notmet: 'Not met',
  unverified: 'Could not verify',
  partial: 'Partially met',
};
type TdProps = React.ComponentPropsWithoutRef<'td'> & ExtraProps;
const VerdictTd: React.FC<TdProps> = ({ node, children, ...rest }) => {
  const kind = verdictKind(hastText(node));
  if (!kind) return <td {...rest}>{children}</td>;
  return (
    <td {...rest} className={`verdict-cell${rest.className ? ` ${rest.className}` : ''}`}>
      <span className={`verdict verdict--${kind}`} title={hastText(node).trim()}>
        {VERDICT_LABEL[kind]}
      </span>
    </td>
  );
};

/**
 * Tables scroll inside their own wrapper (the panel is ~350px wide). An
 * acceptance-criteria table — recognised by its "Verdict" header — is
 * additionally re-flowed by CSS into stacked rows: badge on the left,
 * criterion + evidence on the right, no header row.
 */
type TableProps = React.ComponentPropsWithoutRef<'table'> & ExtraProps;
const ReportTable: React.FC<TableProps> = ({ node, children, ...rest }) => {
  const n = node as { children?: unknown[] } | undefined;
  const thead = (n?.children ?? []).find((c) => (c as { tagName?: string })?.tagName === 'thead');
  const headers = hastText(thead).toLowerCase();
  const isAc = /verdict/.test(headers) && /(criteri|requirement)/.test(headers);
  return (
    <div className={`md-table-wrap${isAc ? ' md-table-wrap--ac' : ''}`}>
      <table {...rest}>{children}</table>
    </div>
  );
};

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

const MARKDOWN_COMPONENTS = {
  pre: CodeBlock,
  code: InlineCode,
  h2: ReportH2,
  h3: ReportH3,
  td: VerdictTd,
  table: ReportTable,
  a: ChatLink,
};

/**
 * Isolated so a parent re-render (new callback props, sibling timeline
 * updates) does not re-parse the markdown unless the text or highlight
 * mode actually changed.
 */
const MarkdownBody = React.memo(function MarkdownBody({
  content,
  highlight,
  orgName,
  projectName,
}: {
  content: string;
  highlight: boolean;
  orgName: string;
  projectName: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={highlight ? [rehypeHighlight] : []}
      components={MARKDOWN_COMPONENTS}
    >
      {linkifyTicketIds(content, (id) => adoWorkItemUrl(orgName, projectName, id))}
    </ReactMarkdown>
  );
});

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
  /**
   * True while this bubble is still receiving tokens. Syntax highlighting is
   * skipped until the stream finishes — rehype-highlight on every typewriter
   * tick is what made the finished report paint slowly.
   */
  isLive?: boolean;
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
  isLive,
}) => {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);
  // Azure DevOps coordinates for turning `#1516750` in the answer into a link.
  // Absent (not connected yet) → ids stay plain text.
  const ado = useSettingsStore((s) => s.config.ado);
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
    // An empty draft is a no-op — don't re-run the turn.
    if (!next) return;
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
    const ok = await copyToClipboard(content);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
            <MarkdownBody
              content={content}
              highlight={!isLive}
              orgName={ado?.orgName ?? ''}
              projectName={ado?.projectName ?? ''}
            />
          </div>
          {turnSummary && turnSummary.filesChanged.length > 0 && (
            <FilesChangedBar summary={turnSummary} report={content} />
          )}
          {!isError && (
            <div className="message-feedback">
              <button
                type="button"
                className={`message-feedback-button${copied ? ' message-feedback-button--copied' : ''}`}
                onClick={copyMessage}
                title={copied ? 'Copied' : 'Copy response'}
                aria-label="Copy response"
              >
                {copied ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
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
          )}
        </>
      )}
    </div>
  );
};

export default React.memo(ChatMessage, (prev, next) => (
  prev.content === next.content &&
  prev.isUser === next.isUser &&
  prev.isError === next.isError &&
  prev.attachments === next.attachments &&
  prev.agentSteps === next.agentSteps &&
  prev.turnSummary === next.turnSummary &&
  prev.timestamp === next.timestamp &&
  prev.checkpointSha === next.checkpointSha &&
  prev.isReverting === next.isReverting &&
  prev.isLive === next.isLive &&
  !!prev.onUndo === !!next.onUndo &&
  !!prev.onRetry === !!next.onRetry &&
  !!prev.onEdit === !!next.onEdit
));
