import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import SettingsButton from './components/Settings';
import { VSCodeAPI } from './vscode';

interface Message {
  content: string;
  isUser: boolean;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showTips, setShowTips] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscode = VSCodeAPI(); // This will now use the singleton instance

  const handleNewChat = () => {
    setIsLoading(true);
    vscode.postMessage({
      type: 'newChat'
    });
    setMessages([]);
    setInputValue('');
    setShowTips(true);
  };

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

  // Add a handler for showing settings
  const handleShowSettings = () => {
    setShowSettings(true);
  };

  // Add a handler for hiding settings
  const handleCloseSettings = () => {
    setShowSettings(false);
  };

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2>WorkspaceGPT</h2>
        <div className="header-buttons">
          <button 
            className="settings-button" 
            onClick={handleShowSettings}
            title="Settings"
            aria-label="Settings"
          >
            <span className="settings-icon">⚙️</span>
          </button>
          <button 
            className="new-chat-button" 
            onClick={handleNewChat} 
            title="Start a new chat"
            aria-label="Start new chat"
          />
        </div>
      </div>
      {showTips && messages.length === 0 ? (
        <div className="welcome-container">
          <h1 className="welcome-title">Hello</h1>
          <p className="welcome-subtitle">How can WorkspaceGPT help?</p>
          <div className="tips-container">
            <h2 className="tips-title">Tips for getting started</h2>
            <div className="tips-list">
              <div className="tip-item">
                <span className="tip-icon">🔗</span>
                <span>Connect your Confluence workspace in Settings to unlock your team's knowledge base</span>
              </div>
              <div className="tip-item">
                <span className="tip-icon">🤖</span>
                <span>Chat naturally with your Confluence docs - ask questions, get insights, and explore your documentation</span>
              </div>
              <div className="tip-item">
                <span className="tip-icon">📁</span>
                <span>Enhance your queries by sharing files in chat - just mention them with <code>@file</code></span>
              </div>
            </div>
          </div>
        </div>
      ) : (
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
      )}
      <div className="input-container">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask WorkspaceGPT..."
          disabled={isLoading}
        />
        <button 
          onClick={handleSendMessage}
          disabled={isLoading || !inputValue.trim()}
          className="send-button"
          aria-label="Send message"
        >
          ➤
        </button>
      </div>
      <SettingsButton 
        isVisible={showSettings} 
        onClose={handleCloseSettings} 
      />
    </div>
  );
};

export default App;