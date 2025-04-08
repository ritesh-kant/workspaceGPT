import React from 'react';
import ReactMarkdown from 'react-markdown';

interface ChatMessageProps {
  content: string;
  isUser: boolean;
  isError?: boolean;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ content, isUser, isError }) => {
  return (
    <div className={`message ${isError ? 'error-message' : isUser ? 'user-message' : 'bot-message'}`}>
      {isUser ? (
        <div className="message-content">{content}</div>
      ) : (
        <div className="message-content markdown-content">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
};

export default ChatMessage;