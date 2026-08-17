import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import CodeBlock from './CodeBlock';

interface ChatMessageProps {
  content: string;
  isUser: boolean;
  isError?: boolean;
  /** Tool-exploration steps taken before this answer — rendered collapsed above it. */
  agentSteps?: string[];
}

const ChatMessage: React.FC<ChatMessageProps> = ({ content, isUser, isError, agentSteps }) => {
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
            <details className='agent-steps'>
              <summary>Explored workspace — {agentSteps.length} step{agentSteps.length === 1 ? '' : 's'}</summary>
              <ul>
                {agentSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ul>
            </details>
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
