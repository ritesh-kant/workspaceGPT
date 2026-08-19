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

interface ChatMessageProps {
  content: string;
  isUser: boolean;
  isError?: boolean;
  /** Tool-exploration steps taken before this answer — rendered collapsed above it. */
  agentSteps?: (AgentStep | string)[];
  /** Duration + files-changed rollup for the agent turn that produced this answer. */
  turnSummary?: TurnSummary;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ content, isUser, isError, agentSteps, turnSummary }) => {
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
        <div className="message-content">{content}</div>
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
