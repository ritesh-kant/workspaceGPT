import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import CodeBlock from './CodeBlock';
import AgentTimeline from './AgentTimeline';
import FilesChangedBar from './FilesChangedBar';
import { AgentStep, TurnSummary } from '../store/chatStore';

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
              components={{ pre: CodeBlock }}
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
