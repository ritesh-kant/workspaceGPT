import React from 'react';
import ReactMarkdown from 'react-markdown';

interface ChatMessageProps {
  content: string;
  isUser: boolean;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ content, isUser }) => {
  return (
    <div className={`message ${isUser ? 'user-message' : 'bot-message'}`}>
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