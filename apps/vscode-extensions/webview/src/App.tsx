import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import { VSCodeAPI } from './vscode';

interface Message {
  content: string;
  isUser: boolean;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscode = VSCodeAPI(); // This will now use the singleton instance

  useEffect(() => {
    // Handle messages from the extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      setIsLoading(false);
      
      switch (message.type) {
        case 'response':
          setMessages(prev => [...prev, { content: message.message, isUser: false }]);
          break;
        case 'error':
          setMessages(prev => [...prev, { content: `Error: ${message.message}`, isUser: false }]);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    // Scroll to bottom when messages change
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (inputValue.trim()) {
      // Add user message to the chat
      setMessages(prev => [...prev, { content: inputValue, isUser: true }]);
      setIsLoading(true);
      
      // Send message to extension
      vscode.postMessage({
        type: 'sendMessage',
        message: inputValue
      });
      
      // Clear input
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  };

  return (
    <div className="chat-container">
      <div className="messages-container">
        {messages.map((message, index) => (
          <ChatMessage 
            key={index} 
            content={message.content} 
            isUser={message.isUser} 
          />
        ))}
        {isLoading && <div className="loading-indicator">Processing...</div>}
        <div ref={messagesEndRef} />
      </div>
      <div className="input-container">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your message..."
          disabled={isLoading}
        />
        <button 
          onClick={handleSendMessage}
          disabled={isLoading || !inputValue.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default App;