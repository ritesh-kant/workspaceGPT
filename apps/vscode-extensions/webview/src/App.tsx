import React, { useEffect, useRef, useState } from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import SettingsButton from './components/Settings';
import { VSCodeAPI } from './vscode';
import {
  setModelState,
  useChatStore,
  useModelActions,
  useModelProviders,
  useSelectedModelProvider,
  useSettingsStore,
} from './store';
import { MESSAGE_TYPES, STORAGE_KEYS } from './constants';
import { settingsDefaultConfig } from './store/settingsStore';

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

  const {
    showSettings,
    setShowSettings,
    setConfig: setSettingsConfig,
  } = useSettingsStore();

  const modelProviders = useModelProviders();

  const selectedModelProvider = useSelectedModelProvider();

  const { handleModelChange } = useModelActions();

  const [activeModels, setActiveModels] = useState<
    {
      provider: string;
      model: string;
    }[]
  >([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscode = VSCodeAPI(); // This will now use the singleton instance

  const [isOllamaRunning, setIsOllamaRunning] = useState(true);

  useEffect(() => {
    // Handle messages from the extension
    console.log('App mounted =====');
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_WORKSPACE_PATH,
    });
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
        case MESSAGE_TYPES.GET_GLOBAL_STATE_RESPONSE:
          if (message.key === STORAGE_KEYS.SETTINGS) {
            setSettingsConfig(message.state?.config || settingsDefaultConfig);
          }
          if (message.key === STORAGE_KEYS.MODEL) {
            // setselectedModelProvider(message.state || modelDefaultConfig);
            setModelState(message.state || selectedModelProvider);
            console.log(
              'selectedModelProvider',
              message.state || selectedModelProvider
            );
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    const activeModelProviders = modelProviders.filter(
      (provider) => provider?.availableModels?.length && provider.selectedModel
    );
    const activeModels: Array<{
      provider: string;
      model: string;
    }> = activeModelProviders.map((provider) => ({
      provider: provider.provider,
      model: provider.selectedModel,
    }));
    setActiveModels(activeModels);
  }, [modelProviders]);

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
    if (selectedModelProvider?.isDownloading) {
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
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider, // Use the provider string from the selectedModelProvider object
      apiKey: selectedModelProvider?.apiKey,
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
            {isLoading && <div className='loading-indicator'>Thinking...</div>}
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
                  : selectedModelProvider?.isDownloading
                    ? 'Please wait for model download to complete...'
                    : 'Ask WorkspaceGPT...'
              }
              disabled={
                isLoading ||
                selectedModelProvider?.isDownloading ||
                !isOllamaRunning
              }
            />
            <div className='input-controls'>
              <div className='model-selector-bottom'>
                <select
                  value={selectedModelProvider?.provider}
                  onChange={(e) => {
                    const providerConfig = activeModels.find(
                      (model) => model.provider === e.target.value
                    );
                    handleModelChange(
                      providerConfig?.model!,
                      providerConfig?.provider!
                    );
                  }}
                  disabled={selectedModelProvider?.isDownloading}
                  className={
                    selectedModelProvider?.isDownloading ? 'loading' : ''
                  }
                >
                  {activeModels && activeModels.length > 0 ? (
                    // Render options from available models
                    activeModels.map((model) => (
                      <option key={model.provider} value={model.provider}>
                        {model.provider} ({model.model})
                      </option>
                    ))
                  ) : (
                    // Fallback options if no models are available
                    <>
                      <option value='llama3.2:1b'>
                        {selectedModelProvider?.isDownloading &&
                        selectedModelProvider?.selectedModel === 'llama3.2:1b'
                          ? `Llama3.2 (${selectedModelProvider.downloadProgress}%)`
                          : 'Llama3.2'}
                      </option>
                    </>
                  )}
                </select>
                {selectedModelProvider?.isDownloading && (
                  <div className='model-progress'>
                    <div
                      className='progress-bar'
                      style={{
                        width: `${selectedModelProvider.downloadProgress}%`,
                      }}
                    />
                  </div>
                )}
              </div>
              <button
                onClick={handleSendMessage}
                disabled={
                  isLoading ||
                  !inputValue.trim() ||
                  selectedModelProvider?.isDownloading
                }
                className='send-button'
                aria-label='Send message'
              >
                ➤
              </button>
            </div>
          </div>
        </div>
        <SettingsButton isVisible={showSettings} onBack={hideSettings} />
      </div>
    </div>
  );
};

export default App;
