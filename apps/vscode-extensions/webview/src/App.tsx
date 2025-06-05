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

  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_WORKSPACE_PATH,
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

  useEffect(() => {
    // Scroll to bottom when messages change
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSendMessage = () => {
    if (inputValue.trim() === '') return;

    // Check if model is currently downloading
    if (!selectedModelProvider?.selectedModel) {
      // Show notification to wait for model download to complete
      addMessage({
        content: 'Please select the model from settings to use the model',
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
    <div className='app-container'>
      <div className='chat-container'>
        {showTips && messages.length === 0 ? (
          <div className='welcome-container'>
            <h1 className='welcome-title'>👋 Hello</h1>
            <p className='welcome-subtitle'>How can WorkspaceGPT help?</p>
            <div className='privacy-container'>
              <div className='privacy-message'>
                <span className='privacy-icon'>🛡️</span>
                <span>
                  Your data stays secure! Everything runs locally on your
                  machine, ensuring complete privacy and security.
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
                selectedModelProvider?.selectedModel
                  ? 'Please configure model to use '
                  : 'Ask WorkspaceGPT...'
              }
            />
            <div className='input-controls'>
              <div className='model-selector-bottom'>
                <select
                  value={selectedModelProvider?.provider}
                  onChange={(e) => {
                    if (e.target.value === 'selectModel') {
                      setShowSettings(true);
                      return;
                    }
                    const providerConfig = activeModels.find(
                      (model) => model.provider === e.target.value
                    );
                    handleModelChange(
                      providerConfig?.model!,
                      providerConfig?.provider!
                    );
                  }}
                >
                  {activeModels?.map((model) => (
                    <option key={model.provider} value={model.provider}>
                      {model.provider} ({model.model})
                    </option>
                  ))}
                  {!activeModels?.length && (
                    <option value='none'>Select Model</option>
                  )}
                  <hr />
                  <option value='selectModel'>Edit...</option>
                </select>
              </div>
              <button
                onClick={handleSendMessage}
                disabled={
                  isLoading ||
                  !inputValue.trim()
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
