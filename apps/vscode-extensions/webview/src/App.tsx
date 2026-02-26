import React, { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import ChatHistorySidebar from './components/ChatHistorySidebar';
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

// Simple UUID generator (no external dep needed)
function generateSessionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const STARTER_PROMPTS = [
  { icon: '🔍', text: 'What does this Project do?' },
  { icon: '📝', text: 'Tell me the architecture of this project' },
  { icon: '🏗️', text: 'Explain the architecture of this Project' },
];

const App: React.FC = () => {
  // Use Zustand stores instead of local state
  const {
    messages,
    inputValue,
    isLoading,
    showTips,
    currentSessionId,
    historyList,
    showHistory,
    addMessage,
    clearMessages,
    setInputValue,
    setIsLoading,
    setShowTips,
    setCurrentSessionId,
    setHistoryList,
    setShowHistory,
    setMessages,
  } = useChatStore();

  const {
    config,
    showSettings,
    setShowSettings,
    setConfig: setSettingsConfig,
  } = useSettingsStore();

  const isConfluenceConnected = config.confluence?.isAuthenticated || false;

  const modelProviders = useModelProviders();

  const selectedModelProvider = useSelectedModelProvider();

  const { handleModelChange } = useModelActions();

  const [activeModels, setActiveModels] = useState<
    {
      provider: string;
      model?: string;
    }[]
  >([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const vscode = VSCodeAPI(); // This will now use the singleton instance

  // Debounced save: to avoid writing to disk on every keystroke / rapid message
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveCurrentChat = useCallback(
    (msgs: typeof messages, sessionId: string | null) => {
      if (!sessionId || msgs.length === 0) return;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        vscode.postMessage({
          type: MESSAGE_TYPES.SAVE_CHAT_HISTORY,
          sessionId,
          messages: msgs,
        });
      }, 500); // 500ms debounce
    },
    [vscode]
  );

  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_WORKSPACE_PATH,
    });

    // Request history list on mount
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_CHAT_HISTORY_LIST,
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
            content: 'Error occurred. Please restart WorkspaceGPT.',
            isUser: false,
            isError: true,
          });
          setIsLoading(false);
          break;
        case MESSAGE_TYPES.SHOW_SETTINGS:
          setShowSettings(true);
          setShowHistory(false);
          break;
        case MESSAGE_TYPES.NEW_CHAT:
          handleNewChat();
          break;
        case MESSAGE_TYPES.SHOW_HISTORY:
          setShowHistory(true);
          setShowSettings(false);
          // Refresh history list when opened
          vscode.postMessage({
            type: MESSAGE_TYPES.GET_CHAT_HISTORY_LIST,
          });
          break;
        case MESSAGE_TYPES.GET_GLOBAL_STATE_RESPONSE:
          if (message.key === STORAGE_KEYS.SETTINGS) {
            setSettingsConfig(message.state?.config || settingsDefaultConfig);
          }
          if (message.key === STORAGE_KEYS.MODEL) {
            if (message.state && message.state.modelProviders) {
              setModelState(message.state);
              console.log(
                'restored model state',
                message.state
              );
            }
          }
          break;
        case MESSAGE_TYPES.GET_CHAT_HISTORY_LIST_RESPONSE:
          setHistoryList(message.historyList || []);
          break;
        case MESSAGE_TYPES.GET_CHAT_SESSION_RESPONSE:
          if (message.messages) {
            setMessages(message.messages);
            setCurrentSessionId(message.sessionId);
            setShowTips(false);
            setShowHistory(false);
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Auto-save whenever messages change (debounced)
  useEffect(() => {
    if (messages.length > 0 && currentSessionId) {
      saveCurrentChat(messages, currentSessionId);
    }
  }, [messages, currentSessionId, saveCurrentChat]);

  useEffect(() => {
    const activeModelProviders = modelProviders.filter(
      (provider) => provider?.availableModels?.length && provider.selectedModel
    );
    const activeModels: Array<{
      provider: string;
      model?: string;
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

  const handleNewChat = () => {
    // Save current chat before starting a new one
    if (currentSessionId && messages.length > 0) {
      // Force an immediate save (no debounce)
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_CHAT_HISTORY,
        sessionId: currentSessionId,
        messages,
      });
    }
    setIsLoading(false);
    clearMessages();
    setInputValue('');
    setCurrentSessionId(null);
    setShowTips(true);
    setShowHistory(false);
    hideSettings();
  };

  const handleSendMessage = () => {
    if (inputValue.trim() === '' || isLoading) return;

    // Check if model is currently downloading
    if (!selectedModelProvider?.selectedModel) {
      // Show notification to wait for model download to complete
      addMessage({
        content: 'Please select the model from settings to use the model',
        isUser: false,
      });
      return;
    }

    // If no session ID yet, generate one now
    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = generateSessionId();
      setCurrentSessionId(sessionId);
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

  const handleStopMessage = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_MESSAGE,
    });
    setIsLoading(false);
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

  const handleStarterPrompt = (promptText: string) => {
    setInputValue(promptText);
    // Trigger send on next tick so inputValue is set
    setTimeout(() => {
      if (!selectedModelProvider?.selectedModel) {
        addMessage({
          content: 'Please select the model from settings to use the model',
          isUser: false,
        });
        return;
      }
      let sessionId = currentSessionId;
      if (!sessionId) {
        sessionId = generateSessionId();
        setCurrentSessionId(sessionId);
      }
      addMessage({ content: promptText, isUser: true });
      setInputValue('');
      setIsLoading(true);
      setShowTips(false);
      vscode.postMessage({
        type: MESSAGE_TYPES.SEND_MESSAGE,
        message: promptText,
        modelId: selectedModelProvider?.selectedModel,
        provider: selectedModelProvider.provider,
        apiKey: selectedModelProvider?.apiKey,
      });
    }, 0);
  };

  const handleSelectSession = (sessionId: string) => {
    // Save current chat first
    if (currentSessionId && messages.length > 0) {
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_CHAT_HISTORY,
        sessionId: currentSessionId,
        messages,
      });
    }
    // Request the session data from the extension host
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_CHAT_SESSION,
      sessionId,
    });
  };

  const handleDeleteSession = (sessionId: string) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.DELETE_CHAT_HISTORY,
      sessionId,
    });
    // If deleting the active session, reset
    if (sessionId === currentSessionId) {
      handleNewChat();
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className='app-container'>
      <div className='chat-container'>
        {showTips && messages.length === 0 ? (
          isConfluenceConnected ? (
            <div className='recent-chats-container'>
              <div className='recent-chats-header'>
                <div className='recent-chats-title-group'>
                  <h2>Recent Chats</h2>
                </div>
                <button
                  onClick={() => setShowHistory(true)}
                  className='see-all-btn'
                  title='View all history'
                >
                  See all
                </button>
              </div>
              <div className='recent-chats-list'>
                {historyList.length === 0 ? (
                  <div className='no-recent-chats'>
                    <p>No recent chats yet. Start a conversation below!</p>
                  </div>
                ) : (
                  historyList.slice(0, 3).map((session) => (
                    <div
                      key={session.id}
                      className='recent-chat-card'
                      onClick={() => handleSelectSession(session.id)}
                    >
                      <div className='recent-chat-card-content'>
                        <span className='recent-chat-card-title'>{session.title}</span>
                        <span className='recent-chat-card-date'>{formatDate(session.updatedAt)}</span>
                      </div>
                      <div className='recent-chat-card-arrow'>→</div>
                    </div>
                  ))
                )}
              </div>
              <div className='prompt-suggestions recent-chats-prompts'>
                <h2 className='prompt-suggestions-title'>Try asking</h2>
                <div className='prompt-suggestions-list'>
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      key={prompt.text}
                      className='prompt-item'
                      onClick={() => handleStarterPrompt(prompt.text)}
                    >
                      <span className='prompt-item-text'>{prompt.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
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
                  <div
                    className='tip-item tip-item--interactive'
                    onClick={() => {
                      setShowSettings(true);
                      setShowHistory(false);
                    }}
                    role='button'
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') { setShowSettings(true); setShowHistory(false); } }}
                  >
                    <span className='tip-icon'>🔗</span>
                    <span>
                      Connect Confluence in Settings to access your team's
                      knowledge base instantly
                    </span>
                    <span className='tip-arrow'>→</span>
                  </div>
                  <div className='tip-item'>
                    <span className='tip-icon'>💡</span>
                    <span>
                      Ask questions naturally about your docs – get insights and
                      explore your documentation effortlessly
                    </span>
                  </div>
                </div>
              </div>
              <div className='prompt-suggestions'>
                <h2 className='prompt-suggestions-title'>💬 Try asking</h2>
                <div className='prompt-suggestions-list'>
                  {STARTER_PROMPTS.map((prompt) => (
                    <button
                      key={prompt.text}
                      className='prompt-item'
                      onClick={() => handleStarterPrompt(prompt.text)}
                    >
                      <span className='prompt-item-icon'>{prompt.icon}</span>
                      <span className='prompt-item-text'>{prompt.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )
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
                  ? 'Ask WorkspaceGPT...'
                  : 'Please configure model to use '
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
              {isLoading ? (
                <button
                  onClick={handleStopMessage}
                  className='stop-button action-btn'
                  aria-label='Stop generation'
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: 'var(--vscode-errorForeground, #f48771)', cursor: 'pointer' }}
                >
                  <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                    <rect x='6' y='6' width='12' height='12' rx='2' fill='currentColor' />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSendMessage}
                  disabled={!inputValue.trim()}
                  className='send-button action-btn'
                  aria-label='Send message'
                >
                  <svg width='16' height='16' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                    <path d='M22 2L11 13' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                    <path d='M22 2L15 22L11 13L2 9L22 2Z' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
        <SettingsButton isVisible={showSettings} onBack={hideSettings} />
        <ChatHistorySidebar
          isVisible={showHistory}
          historyList={historyList}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onClose={() => setShowHistory(false)}
          onNewChat={handleNewChat}
        />
      </div>
    </div>
  );
};

export default App;
