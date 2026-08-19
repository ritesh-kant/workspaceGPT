import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import AgentWriteCard from './components/AgentWriteCard';
import AgentTimeline from './components/AgentTimeline';
import ChatHistorySidebar from './components/ChatHistorySidebar';
import SettingsButton from './components/Settings';
import Releases from './components/Releases';
import Onboarding from './components/onboarding/Onboarding';
import { VSCodeAPI } from './vscode';
import {
  setModelState,
  useChatStore,
  useModelActions,
  useModelProviders,
  useSelectedModelProvider,
  useSettingsStore,
  useUiStore,
} from './store';
import { modelDefaultConfig } from './store/modelStore';
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
  { icon: '', text: 'What does this Project do?' },
  { icon: '', text: 'Explain the architecture of this Project' },
  { icon: '', text: 'Show Azure DevOps tickets assigned to me' },
  { icon: '', text: 'Tell me the status of the ticket tkt-123456' },
];

const App: React.FC = () => {
  // Use Zustand stores instead of local state
  const {
    messages,
    inputValue,
    isLoading,
    isStreaming,
    showTips,
    currentSessionId,
    historyList,
    addMessage,
    appendToLastMessage,
    clearMessages,
    setInputValue,
    setIsLoading,
    setIsStreaming,
    setShowTips,
    setCurrentSessionId,
    setHistoryList,
    setMessages,
    contextSelection,
    setContextSelection,
    statusText,
    setStatusText,
    setWriteReviewDecision,
    closeAllPendingWriteReviews,
    agentSteps,
    addAgentStep,
    updateAgentStep,
    setTurnSummary,
    finalizeAgentTurn,
  } = useChatStore();

  const {
    config,
    setConfig: setSettingsConfig,
  } = useSettingsStore();

  const { activeView, setActiveView, settingsHydrated, setSettingsHydrated } = useUiStore();

  const mode = config.mode;
  const isConfluenceConnected = config.confluence?.isAuthenticated || false;
  const hasRemoteChatKey =
    !!config.embedding?.apiKeys?.some((k) => k.trim()) || !!config.embedding?.apiKey?.trim();

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
  // Only auto-scroll while the user is already reading the tail of the chat.
  // Once they scroll up (e.g. to review a diff card), the view must stay put —
  // a smooth-scroll on every message mutation makes the approve buttons
  // impossible to reach during a live agent run.
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // When true, discard incoming response chunks that belong to a previous request.
  // useRef so it's always current inside the stale useEffect message-handler closure.
  const ignoringStreamRef = useRef(false);

  // Typewriter streaming buffer. Network chunk size varies wildly by provider —
  // some (Ollama, Gemini) emit token-sized deltas, others (NVIDIA) ship the whole
  // completion in one or two large SSE chunks, which renders as a single flash.
  // We buffer all incoming text here and drain it to the UI at a steady rate so
  // streaming looks smooth regardless of how the provider chunks the response.
  const pendingTextRef = useRef('');
  const streamDoneRef = useRef(false);
  const pumpRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Drains pendingTextRef into the last message a few chars per tick so the
  // response "types out" smoothly. Pauses itself when the buffer empties (and
  // restarts on the next chunk); finalizes streaming state once the stream is
  // done and fully drained. The slice scales with the backlog, so a provider
  // that delivers the whole response in one chunk still finishes in ~0.5s
  // rather than typing for tens of seconds.
  const startStreamPump = useCallback(() => {
    if (pumpRef.current !== null) return; // already running
    pumpRef.current = setInterval(() => {
      const pending = pendingTextRef.current;
      if (pending.length === 0) {
        if (pumpRef.current !== null) {
          clearInterval(pumpRef.current);
          pumpRef.current = null;
        }
        if (streamDoneRef.current) {
          streamDoneRef.current = false;
          setIsStreaming(false);
        }
        return;
      }
      const count = Math.max(2, Math.ceil(pending.length / 30));
      pendingTextRef.current = pending.slice(count);
      appendToLastMessage(pending.slice(0, count));
    }, 16);
  }, [appendToLastMessage, setIsStreaming]);

  // Stops the pump and discards any buffered text — used when a stream is
  // abandoned (new chat, new message, stop, error).
  const resetStreamBuffer = useCallback(() => {
    if (pumpRef.current !== null) {
      clearInterval(pumpRef.current);
      pumpRef.current = null;
    }
    pendingTextRef.current = '';
    streamDoneRef.current = false;
  }, []);

  // Clean up the pump on unmount.
  useEffect(() => () => resetStreamBuffer(), [resetStreamBuffer]);

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
          if (ignoringStreamRef.current) break;
          addMessage({
            content: message.content,
            isUser: false,
          });
          setStatusText('');
          setIsLoading(false);
          setIsStreaming(false);
          break;
        case MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK:
          if (ignoringStreamRef.current) break;
          // Buffer the chunk; the pump drains it to the UI at a steady rate.
          pendingTextRef.current += message.content || '';
          setStatusText('');
          setIsLoading(false); // Stop loading animation since we're streaming now
          setIsStreaming(true);
          startStreamPump();
          break;
        case MESSAGE_TYPES.RECEIVE_MESSAGE_DONE: {
          ignoringStreamRef.current = false;
          setStatusText('');
          setIsLoading(false);
          // Don't clear isStreaming yet — let the pump finish draining the
          // buffer first, then it flips isStreaming off itself.
          streamDoneRef.current = true;
          startStreamPump();
          // The model finished without any text (rare): the steps and
          // files-changed rollup accumulated this turn must never vanish —
          // materialize a fallback answer to carry them.
          if (pendingTextRef.current.length === 0) {
            const { messages: currentMsgs } = useChatStore.getState();
            const last = currentMsgs[currentMsgs.length - 1];
            if (!last || last.isUser || last.writeReview) {
              finalizeAgentTurn('Done — see the steps above for what was explored and changed.');
            }
          }
          break;
        }
        case MESSAGE_TYPES.RETRIEVAL_STATUS:
          setStatusText(message.text || '');
          break;
        case MESSAGE_TYPES.AGENT_STEP:
          if (message.step) {
            addAgentStep({ ...message.step, ...(message.id ? { id: message.id } : {}) });
          } else if (message.text) {
            // Back-compat with an older extension host still posting plain text.
            addAgentStep({ kind: 'info', title: message.text });
          }
          break;
        case MESSAGE_TYPES.AGENT_STEP_UPDATE:
          if (message.id) {
            updateAgentStep(message.id, {
              status: message.status || 'done',
              summary: message.summary,
              meta: message.meta,
            });
          }
          break;
        case MESSAGE_TYPES.AGENT_TURN_SUMMARY:
          setTurnSummary({
            durationMs: message.durationMs || 0,
            filesChanged: message.filesChanged || [],
          });
          break;
        case MESSAGE_TYPES.AGENT_WRITE_REVIEWS_CLOSED:
          // Host auto-rejected every parked review (user hit Stop / run died).
          // Mark the cards so their buttons don't dangle as live-looking no-ops.
          closeAllPendingWriteReviews();
          setStatusText('');
          break;
        case MESSAGE_TYPES.AGENT_WRITE_REVIEW:
          // A proposed agent write — render the diff card. The agent run is
          // still alive host-side, parked on this decision, so keep isLoading.
          addMessage({
            content: '',
            isUser: false,
            writeReview: {
              id: message.id,
              kind: message.kind,
              path: message.path,
              summary: message.summary,
              diff: message.diff,
              command: message.command,
            },
          });
          setStatusText('Waiting for your review…');
          break;
        case MESSAGE_TYPES.ERROR_CHAT: {
          const rawError = message.message || 'An unknown error occurred.';
          let userFacingError: string;

          if (rawError.includes('403') && rawError.includes('subscription')) {
            // Extract the upgrade URL if present
            const urlMatch = rawError.match(/https?:\/\/[^\s")]+/);
            const upgradeUrl = urlMatch ? urlMatch[0] : null;
            userFacingError = `⚠️ **Access Denied (403):** This model requires a subscription.\n\n`
              + (upgradeUrl
                ? `Upgrade here: [${upgradeUrl}](${upgradeUrl})\n\n`
                : '')
              + `Please select a different model or upgrade your plan.`;
          } else if (rawError.includes('401') || rawError.includes('Unauthorized')) {
            userFacingError = `🔑 **Authentication Error:** Your API key appears to be invalid or expired. Please check your API key in Settings.`;
          } else if (rawError.includes('429') || rawError.includes('rate limit')) {
            userFacingError = `⏳ **Rate Limited:** Too many requests. Please wait a moment and try again.`;
          } else if (rawError.includes('ECONNREFUSED') || rawError.includes('ENOTFOUND')) {
            userFacingError = `🔌 **Connection Error:** Unable to reach the model provider. Please check that the service is running and your network connection is active.`;
          } else {
            userFacingError = `❌ **Error:** ${rawError}`;
          }

          resetStreamBuffer();
          addMessage({
            content: userFacingError,
            isUser: false,
            isError: true,
          });
          setStatusText('');
          setIsLoading(false);
          setIsStreaming(false);
          break;
        }
        case MESSAGE_TYPES.SHOW_SETTINGS:
          setActiveView('settings');
          break;
        case MESSAGE_TYPES.NEW_CHAT:
          handleNewChat();
          break;
        case MESSAGE_TYPES.SHOW_HISTORY:
          setActiveView('history');
          // Refresh history list when opened
          vscode.postMessage({
            type: MESSAGE_TYPES.GET_CHAT_HISTORY_LIST,
          });
          break;
        case MESSAGE_TYPES.SHOW_RELEASES:
          setActiveView('releases');
          break;
        case MESSAGE_TYPES.GET_GLOBAL_STATE_RESPONSE:
          if (message.key === STORAGE_KEYS.SETTINGS) {
            const restoredConfig = message.state?.config || settingsDefaultConfig;
            // Transient sync/index UI state is not meaningful across restarts.
            // isSyncing, progress values, status messages, etc. were written during
            // a previous session's run. Reset them to defaults so the UI doesn't
            // show a stale "Syncing (100%)" or similar on every extension restart.
            const transientConfluenceDefaults = {
              isSyncing: false,
              isIndexing: false,
              confluenceSyncProgress: 0,
              confluenceIndexProgress: 0,
              canResume: false,
              canResumeIndexing: false,
              isSyncCompleted: restoredConfig.confluence?.isSyncCompleted ?? false,
              isIndexingCompleted: restoredConfig.confluence?.isIndexingCompleted ?? false,
              statusMessage: '',
              messageType: 'success' as const,
              isConnecting: false,
            };
            const transientAdoDefaults = {
              isSyncing: false,
              isIndexing: false,
              adoSyncProgress: 0,
              adoIndexProgress: 0,
              canResume: false,
              canResumeIndexing: false,
              isSyncCompleted: restoredConfig.ado?.isSyncCompleted ?? false,
              isIndexingCompleted: restoredConfig.ado?.isIndexingCompleted ?? false,
              statusMessage: '',
              messageType: 'success' as const,
              isConnecting: false,
            };
            const transientCodebaseDefaults = {
              isSyncing: false,
              isIndexing: false,
              codebaseSyncProgress: 0,
              codebaseIndexProgress: 0,
              canResume: false,
              canResumeIndexing: false,
              isSyncCompleted: restoredConfig.codebase?.isSyncCompleted ?? false,
              isIndexingCompleted: restoredConfig.codebase?.isIndexingCompleted ?? false,
              statusMessage: '',
              messageType: 'success' as const,
            };
            setSettingsConfig({
              ...restoredConfig,
              confluence: { ...restoredConfig.confluence, ...transientConfluenceDefaults },
              ado: { ...restoredConfig.ado, ...transientAdoDefaults },
              codebase: { ...restoredConfig.codebase, ...transientCodebaseDefaults },
            });
            setSettingsHydrated(true);
            if (!restoredConfig.onboardingCompleted) {
              setActiveView('onboarding');
            }
          }
          if (message.key === STORAGE_KEYS.MODEL) {
            if (message.state && message.state.modelProviders) {
              // Merge any newly added providers that aren't in the persisted state
              const persisted = message.state.modelProviders as Array<{ provider: string }>;
              const persistedNames = new Set(persisted.map((p) => p.provider));
              const missing = modelDefaultConfig.filter(
                (p: { provider: string }) => !persistedNames.has(p.provider)
              );
              if (missing.length > 0) {
                message.state.modelProviders = [...persisted, ...missing];
              }
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
            setActiveView('chat');
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
    // Scroll to bottom when messages change — but never yank the viewport
    // away from a user who scrolled up to read/approve something.
    if (nearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  useEffect(() => {
    // Auto-focus input on mount
    if (inputRef.current) {
      inputRef.current.focus();
    }

    // Auto-focus input when webview window regains focus
    const handleWindowFocus = () => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, []);

  const handleNewChat = () => {
    // Discard any in-flight chunks from the previous request.
    // ignoringStreamRef is read synchronously in the message handler closure,
    // so this takes effect immediately even before the worker is terminated.
    ignoringStreamRef.current = true;
    resetStreamBuffer();

    // Best-effort: also tell the extension host to terminate the worker.
    if (isLoading || isStreaming) {
      vscode.postMessage({ type: MESSAGE_TYPES.STOP_MESSAGE });
    }

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
    setIsStreaming(false);
    setStatusText('');
    clearMessages();
    setInputValue('');
    setCurrentSessionId(null);
    setShowTips(true);
    setActiveView('chat');
  };

  const handleSendMessage = () => {
    if (inputValue.trim() === '' || isLoading) return;
    ignoringStreamRef.current = false; // Accept chunks for this new request
    resetStreamBuffer(); // Discard any leftover buffer from a prior stream

    // Local mode: a model must be selected. Remote mode has no model picker —
    // it just needs a Gemini key (the host routes the actual model by task).
    if (mode === 'local' && !selectedModelProvider?.selectedModel) {
      addMessage({
        content: 'Please select the model from settings to use the model',
        isUser: false,
      });
      return;
    }
    if (mode === 'remote' && !hasRemoteChatKey) {
      addMessage({
        content: 'Add your Gemini API key in Settings to start chatting.',
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
    setIsStreaming(false);
    setShowTips(false);

    // Get the selected model directly from the dropdown

    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      message: inputValue,
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider, // Use the provider string from the selectedModelProvider object
      apiKey: selectedModelProvider?.apiKey,
      contextSelection: contextSelection,
    });
  };

  const handleStopMessage = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_MESSAGE,
    });
    resetStreamBuffer();
    setIsLoading(false);
    setIsStreaming(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Enter inserts a newline (default textarea behavior); plain Enter
    // sends. Ignore Enter while an IME composition is in progress so picking
    // a candidate doesn't submit early.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Auto-grow the composer up to ~7 lines, then let it scroll internally.
  const AUTOSIZE_MAX_HEIGHT = 168;
  const autosizeInput = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    // Collapse first so scrollHeight reports the content height rather than
    // the previously-set height.
    el.style.height = 'auto';
    const contentHeight = el.scrollHeight;
    el.style.height = `${Math.min(contentHeight, AUTOSIZE_MAX_HEIGHT)}px`;
    // Only show the internal scrollbar once content actually exceeds the cap.
    el.style.overflowY = contentHeight > AUTOSIZE_MAX_HEIGHT ? 'auto' : 'hidden';
  };

  // Resize for every value change, not just typing — starter prompts and the
  // reset-to-empty after send set inputValue programmatically, and those must
  // shrink/grow the box too. Layout effect so it lands before paint.
  useLayoutEffect(() => {
    autosizeInput(inputRef.current);
  }, [inputValue]);

  const handleStarterPrompt = (promptText: string) => {
    setInputValue(promptText);
    // Trigger send on next tick so inputValue is set
    setTimeout(() => {
      if (mode === 'local' && !selectedModelProvider?.selectedModel) {
        addMessage({
          content: 'Please select the model from settings to use the model',
          isUser: false,
        });
        return;
      }
      if (mode === 'remote' && !hasRemoteChatKey) {
        addMessage({
          content: 'Add your Gemini API key in Settings to start chatting.',
          isUser: false,
        });
        return;
      }
      ignoringStreamRef.current = false; // Accept chunks for this new request
      resetStreamBuffer(); // Discard any leftover buffer from a prior stream
      let sessionId = currentSessionId;
      if (!sessionId) {
        sessionId = generateSessionId();
        setCurrentSessionId(sessionId);
      }
      addMessage({ content: promptText, isUser: true });
      setInputValue('');
      setIsLoading(true);
      setIsStreaming(false);
      setShowTips(false);
      vscode.postMessage({
        type: MESSAGE_TYPES.SEND_MESSAGE,
        message: promptText,
        modelId: selectedModelProvider?.selectedModel,
        provider: selectedModelProvider.provider,
        apiKey: selectedModelProvider?.apiKey,
        contextSelection: contextSelection,
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

  // Wait for the persisted settings blob before rendering anything — otherwise
  // a returning user would see a flash of onboarding for the instant before
  // `onboardingCompleted` loads in.
  if (!settingsHydrated) {
    return <div className='app-container app-loading' />;
  }

  if (activeView === 'onboarding') {
    return <Onboarding onFinish={() => setActiveView('chat')} />;
  }

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
                  onClick={() => setActiveView('history')}
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
                    {mode === 'remote'
                      ? "You're in Remote mode: chat models run in the cloud, and your search index lives in your own Qdrant cluster."
                      : "You're in Local mode: everything — chat model, embeddings, and your search index — runs on this machine."}
                  </span>
                </div>
              </div>
              <div className='tips-container'>
                <h2 className='tips-title'>✨ Quick Tips</h2>
                <div className='tips-list'>
                  <div
                    className='tip-item tip-item--interactive'
                    onClick={() => setActiveView('settings')}
                    role='button'
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setActiveView('settings'); }}
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
          <div className='messages-container' ref={messagesContainerRef} onScroll={handleMessagesScroll}>
            {messages.map((message, index) =>
              message.writeReview ? (
                <AgentWriteCard
                  key={message.writeReview.id}
                  review={message.writeReview}
                  onDecided={(id, decision) => {
                    setWriteReviewDecision(id, decision);
                    // The run resumes host-side; stop claiming we're waiting.
                    setStatusText('');
                  }}
                />
              ) : (
                <ChatMessage
                  key={index}
                  content={message.content}
                  isUser={message.isUser}
                  isError={message.isError}
                  agentSteps={message.agentSteps}
                  turnSummary={message.turnSummary}
                />
              )
            )}
            {isLoading && (
              <div className='loading-indicator'>
                {agentSteps.length > 0 && <AgentTimeline steps={agentSteps} live />}
                <div className='loading-indicator-row'>
                  <span className='loading-pulse' />
                  <span>{statusText || 'Thinking...'}</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
        <div className='input-container'>
          <div className='input-wrapper'>
            <textarea
              ref={inputRef}
              rows={1}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                mode === 'remote'
                  ? hasRemoteChatKey
                    ? 'Ask WorkspaceGPT...'
                    : 'Add your Gemini key in Settings to start chatting...'
                  : selectedModelProvider?.selectedModel
                    ? 'Ask WorkspaceGPT...'
                    : 'Please configure a model in Settings to start chatting...'
              }
            />
            <div className='input-controls'>
              <div className='input-selectors'>
                <button
                  type='button'
                  className='mode-chip'
                  onClick={() => setActiveView('settings')}
                  title={`${mode === 'remote' ? 'Remote' : 'Local'} mode — click to change`}
                >
                  <span className={`mode-chip-dot mode-chip-dot--${mode}`} />
                  {mode === 'remote' ? 'Remote' : 'Local'}
                </button>
                <div className='context-selector-bottom'>
                  <select
                    value={contextSelection}
                    onChange={(e) => setContextSelection(e.target.value)}
                  >
                    <option value='Auto'>Context: Auto ✨</option>
                    <option value='Confluence'>Confluence</option>
                    <option value='Azure DevOps'>Azure DevOps</option>
                    <option value='Codebase'>Codebase</option>
                  </select>
                </div>
                {mode === 'local' && (
                  <div className='model-selector-bottom'>
                    <select
                      value={selectedModelProvider?.provider}
                      onChange={(e) => {
                        if (e.target.value === 'selectModel') {
                          setActiveView('settings');
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
                      <option value='selectModel'>Edit...</option>
                    </select>
                  </div>
                )}
              </div>
              {isLoading || isStreaming ? (
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
        <SettingsButton isVisible={activeView === 'settings'} onBack={() => setActiveView('chat')} />
        <Releases isVisible={activeView === 'releases'} onBack={() => setActiveView('chat')} />
        <ChatHistorySidebar
          isVisible={activeView === 'history'}
          historyList={historyList}
          currentSessionId={currentSessionId}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onClose={() => setActiveView('chat')}
          onNewChat={handleNewChat}
        />
      </div>
    </div>
  );
};

export default App;
