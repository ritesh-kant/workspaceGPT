import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import SettingsButton from './components/Settings';
import { VSCodeAPI } from './vscode';
import { useChatStore, useSettingsStore, useModelStore } from './store';
import { MESSAGE_TYPES, STORAGE_KEYS } from './constants';
import { settingsDefaultConfig } from './store/settingsStore';
import { modelDefaultConfig } from './store/modelStore';

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
    setShowTips,
  } = useChatStore();

  const { showSettings, setShowSettings, setConfig: setSettingsConfig } = useSettingsStore();
  const {
    config: modelConfig,
    batchUpdateConfig: batchUpdateModelConfig,
    setConfig: setModelConfig,
    handleModelChange,

  } = useModelStore();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscode = VSCodeAPI(); // This will now use the singleton instance

  const [isOllamaRunning, setIsOllamaRunning] = useState(true);

  useEffect(() => {
    // Handle messages from the extension

    vscode.postMessage({
      type: MESSAGE_TYPES.RETRY_OLLAMA_CHECK,
    });
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
          batchUpdateModelConfig({
            isDownloading: true,
            downloadProgress: message.progress ?? '0',
            downloadStatus: 'downloading',
            downloadDetails: {
              current: message.current || '0 MB',
              total: message.total || '0 MB',
            },
          });
          break;
        case MESSAGE_TYPES.MODEL_DOWNLOAD_COMPLETE:
          let availableModels;
          if (message.models && Array.isArray(message.models)) {
            availableModels = message.models.filter(
              (eachModel: { name: string }) => !eachModel.name.includes('embed')
            );
          }

          batchUpdateModelConfig({
            isDownloading: false,
            downloadProgress: 100,
            downloadStatus: 'completed',
            availableModels,
          });
          break;
        case MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR:
          batchUpdateModelConfig({
            isDownloading: false,
            downloadStatus: 'error',
            errorMessage: message.message,
          });
          break;
        case MESSAGE_TYPES.ERROR_CHAT:
          addMessage({
            content: 'Error occurred. Please start a new chat.',
            isUser: false,
            isError: true,
          });
          setIsLoading(false);
          break;
        case MESSAGE_TYPES.OLLAMA_STATUS:
          setIsOllamaRunning(message.isRunning);
          break;
        case MESSAGE_TYPES.SHOW_SETTINGS:
          setShowSettings(true);
          break;
        case MESSAGE_TYPES.NEW_CHAT:
          // Clear messages and reset the chat state
          setIsLoading(true);
          clearMessages();
          setInputValue('');
          setIsLoading(false);
          setShowTips(true);
          hideSettings();
          break;
        case MESSAGE_TYPES.GET_GLOBAL_STATE:
          if (message.key === STORAGE_KEYS.SETTINGS) {
            setSettingsConfig(message.state || settingsDefaultConfig);
          }
          if (message.key === STORAGE_KEYS.MODEL) {
            setModelConfig(message.state || modelDefaultConfig);
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleRetryOllama = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RETRY_OLLAMA_CHECK,
    });
  };

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
        content:
          'Please wait for the model download to complete before sending messages.',
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

    // Get the selected model directly from the dropdown

    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      message: inputValue,
      modelId: modelConfig.selectedModel,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSendMessage();
    }
  };

  // Add a handler for hiding settings
  const hideSettings = () => {
    setShowSettings(false);
  };

  return (
    <div
      className='app-container'
      style={
        {
          '--banner-height': !isOllamaRunning ? '30px' : '0',
        } as React.CSSProperties
      }
    >
      {!isOllamaRunning && (
        <div className='banner-container'>
          <div className='banner-content'>
            <div className='banner-message'>
              <span className='warning-icon'>⚠️</span>
              <span>Ollama Service Not Running</span>
              <button
                onClick={handleRetryOllama}
                className='retry-button'
                title='Retry connection'
              >
                ↻
              </button>
            </div>
          </div>
        </div>
      )}
      <div className='chat-container'>

        {showTips && messages.length === 0 ? (
          <div className='welcome-container'>
            <h1 className='welcome-title'>👋 Hello</h1>
            <p className='welcome-subtitle'>How can WorkspaceGPT help?</p>
            <div className='prerequisite-container'>
              <div className='prerequisite-message'>
                <span className='prerequisite-icon'>⚙️</span>
                <span>
                  To get started, please install{' '}
                  <a
                    href='https://ollama.com'
                    target='_blank'
                    rel='noopener noreferrer'
                  >
                    Ollama
                  </a>{' '}
                  on your system - it's quick and easy!
                </span>
              </div>
            </div>
            <div className='privacy-container'>
              <div className='privacy-message'>
                <span className='privacy-icon'>🛡️</span>
                <span>
                  Your data stays secure! Everything runs locally on your
                  machine, ensuring complete privacy and security. Think of it
                  as your personal AI assistant that respects your
                  confidentiality.
                </span>
              </div>
            </div>
            <div className='tips-container'>
              <h2 className='tips-title'>✨ Quick Tips</h2>
              <div className='tips-list'>
                <div className='tip-item'>
                  <span className='tip-icon'>🔗</span>
                  <span>
                    Connect Confluence in Settings to access your team's
                    knowledge base instantly
                  </span>
                </div>
                <div className='tip-item'>
                  <span className='tip-icon'>💡</span>
                  <span>
                    Ask questions naturally about your docs - get insights and
                    explore your documentation effortlessly
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className='messages-container'>
            {messages.map((message, index) => (
              <ChatMessage
                key={index}
                content={message.content}
                isUser={message.isUser}
                isError={message.isError}
              />
            ))}
            {isLoading && (
              <div className='loading-indicator'>Thinking...</div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
        <div className='input-container'>
          <div className='input-wrapper'>
            <input
              type='text'
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                !isOllamaRunning
                  ? 'Ollama service is not running'
                  : modelConfig.isDownloading
                    ? 'Please wait for model download to complete...'
                    : 'Ask WorkspaceGPT...'
              }
              disabled={
                isLoading || modelConfig.isDownloading || !isOllamaRunning
              }
            />
            <div className='input-controls'>
              <div className='model-selector-bottom'>
                <select
                  value={modelConfig.selectedModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  disabled={modelConfig.isDownloading}
                  className={modelConfig.isDownloading ? 'loading' : ''}
                >
                  {modelConfig.availableModels &&
                  modelConfig.availableModels.length > 0 ? (
                    // Render options from available models
                    modelConfig.availableModels.map((model) => (
                      <option key={model.model} value={model.model}>
                        {modelConfig.isDownloading &&
                        modelConfig.selectedModel === model.model
                        ? `${model.name} (${modelConfig.downloadProgress}%)`
                        : `${model.name} (${model?.details?.parameter_size})`}
                      </option>
                    ))
                  ) : (
                    // Fallback options if no models are available
                    <>
                      <option value='llama3.2:1b'>
                        {modelConfig.isDownloading &&
                        modelConfig.selectedModel === 'llama3.2:1b'
                        ? `Llama3.2 (${modelConfig.downloadProgress}%)`
                        : 'Llama3.2'}
                      </option>
                    </>
                  )}
                </select>
                {modelConfig.isDownloading && (
                  <div className='model-progress'>
                    <div
                      className='progress-bar'
                      style={{ width: `${modelConfig.downloadProgress}%` }}
                    />
                  </div>
                )}
              </div>
              <button
                onClick={handleSendMessage}
                disabled={
                  isLoading || !inputValue.trim() || modelConfig.isDownloading
                }
                className='send-button'
                aria-label='Send message'
              >
                ➤
              </button>
            </div>
          </div>
        </div>
        <SettingsButton
          isVisible={showSettings}
          onBack={hideSettings}
        />
      </div>
    </div>
  );
};

export default App;
