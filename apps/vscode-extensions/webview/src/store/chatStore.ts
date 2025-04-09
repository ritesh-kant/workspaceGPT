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

interface ChatState {
  messages: Message[];
  inputValue: string;
  isLoading: boolean;
  showTips: boolean;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  clearMessages: () => void;
  setInputValue: (value: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setShowTips: (showTips: boolean) => void;
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
  showTips: true,
};

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      ...chatDefaultState,
      setMessages: (messages) => set({ messages }),
      addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
      clearMessages: () => set({ messages: [] }),
      setInputValue: (inputValue) => set({ inputValue }),
      setIsLoading: (isLoading) => set({ isLoading }),
      setShowTips: (showTips) => set({ showTips }),
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