import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { STORAGE_KEYS } from '../constants';
import { MESSAGE_TYPES } from '../constants';

interface Message {
  content: string;
  isUser: boolean;
  isError?: boolean;
}

interface ChatSessionPreview {
  id: string;
  title: string;
  updatedAt: number;
}

interface ChatState {
  messages: Message[];
  inputValue: string;
  isLoading: boolean;
  isStreaming: boolean;
  showTips: boolean;
  currentSessionId: string | null;
  historyList: ChatSessionPreview[];
  showHistory: boolean;
  contextSelection: string;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  appendToLastMessage: (content: string) => void;
  clearMessages: () => void;
  setInputValue: (value: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsStreaming: (isStreaming: boolean) => void;
  setShowTips: (showTips: boolean) => void;
  setCurrentSessionId: (id: string | null) => void;
  setHistoryList: (list: ChatSessionPreview[]) => void;
  setShowHistory: (show: boolean) => void;
  setContextSelection: (selection: string) => void;
  resetStore: () => void;
}

// Create a custom storage adapter for VSCode
const vscodeStorage = {
  getItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    return JSON.stringify(state[STORAGE_KEYS.CHAT] || []);
  },
  setItem: (_name: string, value: string) => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    vscode.setState({ ...state, [STORAGE_KEYS.CHAT]: JSON.parse(value) });
  },
  removeItem: () => {
    const vscode = VSCodeAPI();
    const state = vscode.getState() || {};
    const { [STORAGE_KEYS.CHAT]: chat, ...rest } = state;
    vscode.setState(rest);
  },
};

export const chatDefaultState = {
  messages: [],
  inputValue: '',
  isLoading: false,
  isStreaming: false,
  showTips: true,
  currentSessionId: null,
  historyList: [],
  showHistory: false,
  contextSelection: 'Auto',
};

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      ...chatDefaultState,
      setMessages: (messages) => set({ messages }),
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      appendToLastMessage: (content) => set((state) => {
        const msgs = [...state.messages];
        if (msgs.length > 0 && !msgs[msgs.length - 1].isUser) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + content };
        } else {
          msgs.push({ content, isUser: false });
        }
        return { messages: msgs };
      }),
      clearMessages: () => set({ messages: [] }),
      setInputValue: (inputValue) => set({ inputValue }),
      setIsLoading: (isLoading) => set({ isLoading }),
      setIsStreaming: (isStreaming) => set({ isStreaming }),
      setShowTips: (showTips) => set({ showTips }),
      setCurrentSessionId: (currentSessionId) => set({ currentSessionId }),
      setHistoryList: (historyList) => set({ historyList }),
      setShowHistory: (showHistory) => set({ showHistory }),
      setContextSelection: (contextSelection) => set({ contextSelection }),
      resetStore: () => {
        const vscode = VSCodeAPI();
        vscode.setState({});
        vscode.postMessage({
          type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
        });
        set(chatDefaultState);
      },
    }),
    {
      name: 'workspaceGPT-chat-storage',
      storage: createJSONStorage(() => vscodeStorage),
    }
  )
);