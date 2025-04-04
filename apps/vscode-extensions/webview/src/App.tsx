import React, { useEffect, useRef } from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import SettingsButton from './components/Settings';
import { VSCodeAPI } from './vscode';
import { useChatStore, useSettingsStore, useModelStore } from './store';
import { MESSAGE_TYPES } from './constants';

const App: React.FC = () => {
  // Use Zustand stores instead of local state
  const { 
    messages, 
    inputValue, 
    isLoading, 
    showTips, 
    addMessage, 
    clearMessages, 
    setInputValue, 
    setIsLoading, 
    setShowTips 
  } = useChatStore();
  
  const { showSettings, setShowSettings } = useSettingsStore();
  const { config: modelConfig, updateConfig: updateModelConfig } = useModelStore();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscode = VSCodeAPI(); // This will now use the singleton instance

  const handleNewChat = () => {
    setIsLoading(true);
    vscode.postMessage({
      type: MESSAGE_TYPES.NEW_CHAT,
    });
    clearMessages();
    setInputValue('');
    setIsLoading(false);
    setShowTips(true);
  };

  const handleModelChange = (modelId: string) => {
    updateModelConfig('selectedModel', modelId);
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_MODEL,
      modelId
    });
  };

  useEffect(() => {
    // Handle messages from the extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case MESSAGE_TYPES.RECEIVE_MESSAGE:
          addMessage({
            content: message.content,
            isUser: false,
          });
          setIsLoading(false);
          break;
        case MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS:
          
          updateModelConfig('isDownloading', true);
          updateModelConfig('downloadProgress', message.progress ?? '0');
          updateModelConfig('downloadStatus', 'downloading');
          updateModelConfig('downloadDetails', {
            current: message.current || '0 MB',
            total: message.total || '0 MB'
          });
          break;
        case MESSAGE_TYPES.MODEL_DOWNLOAD_COMPLETE:
          updateModelConfig('isDownloading', false);
          updateModelConfig('downloadProgress', 100);
          updateModelConfig('downloadStatus', 'completed');
          // Store available models if provided
          if (message.models && Array.isArray(message.models)) {
            updateModelConfig('availableModels', message.models);
          }
          break;
        case MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR:
          updateModelConfig('isDownloading', false);
          updateModelConfig('downloadStatus', 'error');
          updateModelConfig('errorMessage', message.message);
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
    if (inputValue.trim() === '') return;
    
    // Check if model is currently downloading
    if (modelConfig.isDownloading) {
      // Show notification to wait for model download to complete
      addMessage({
        content: "Please wait for the model download to complete before sending messages.",
        isUser: false,
      });
      return;
    }

    addMessage({
      content: inputValue,
      isUser: true,
    });

    setInputValue('');
    setIsLoading(true);
    setShowTips(false);

    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      message: inputValue,
      modelId: modelConfig.selectedModel, // Include the selected model ID in the message event
    });
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
        <div className="header-controls">
          <div className="model-selector">
            <select
              value={modelConfig.selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={modelConfig.isDownloading}
              className={modelConfig.isDownloading ? 'loading' : ''}
            >
              {modelConfig.availableModels && modelConfig.availableModels.length > 0 ? (
                // Render options from available models
                modelConfig.availableModels.map((model) => (
                  <option key={model.model} value={model.model}>
                    {modelConfig.isDownloading && modelConfig.selectedModel === model.model
                      ? `${model.name} (${modelConfig.downloadProgress}%)`
                      : `${model.name} (${model?.details?.parameter_size})`}
                  </option>
                ))
              ) : (
                // Fallback options if no models are available
                <>
                  <option value="llama3.2:1b">
                    {modelConfig.isDownloading && modelConfig.selectedModel === "llama3.2:1b"
                      ? `Llama3.2 (${modelConfig.downloadProgress}%)`
                      : "Llama3.2"}
                  </option>
                </>
              )}
            </select>
            {modelConfig.isDownloading && (
              <div className="model-progress">
                <div 
                  className="progress-bar" 
                  style={{ width: `${modelConfig.downloadProgress}%` }} 
                />
              </div>
            )}
          </div>
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
          placeholder={modelConfig.isDownloading ? "Please wait for model download to complete..." : "Ask WorkspaceGPT..."}
          disabled={isLoading || modelConfig.isDownloading}
        />
        <button 
          onClick={handleSendMessage}
          disabled={isLoading || !inputValue.trim() || modelConfig.isDownloading}
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