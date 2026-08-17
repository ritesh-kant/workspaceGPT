import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { STORAGE_KEYS } from '../constants';
import { MESSAGE_TYPES } from '../constants';

/** A proposed agent action awaiting (or past) user review — file write or command. */
export interface WriteReview {
  id: string;
  kind: 'edit' | 'create' | 'delete' | 'command';
  path: string;
  summary: string;
  diff: { added: number; removed: number; text: string };
  /** The shell command, when kind === 'command'. */
  command?: string;
  /** Set once the user decides; collapses the buttons into a badge. */
  decision?: 'approved' | 'rejected';
}

interface Message {
  content: string;
  isUser: boolean;
  isError?: boolean;
  writeReview?: WriteReview;
  /** Tool-exploration steps the agent took before producing this answer. */
  agentSteps?: string[];
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
  contextSelection: string;
  statusText: string;
  /** Steps accumulated for the in-flight turn; attached to the next assistant message. */
  agentSteps: string[];
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  appendToLastMessage: (content: string) => void;
  addAgentStep: (step: string) => void;
  clearMessages: () => void;
  setInputValue: (value: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsStreaming: (isStreaming: boolean) => void;
  setShowTips: (showTips: boolean) => void;
  setCurrentSessionId: (id: string | null) => void;
  setHistoryList: (list: ChatSessionPreview[]) => void;
  setContextSelection: (selection: string) => void;
  setStatusText: (text: string) => void;
  setWriteReviewDecision: (reviewId: string, decision: 'approved' | 'rejected') => void;
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
  contextSelection: 'Auto',
  statusText: '',
  agentSteps: [],
};

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      ...chatDefaultState,
      setMessages: (messages) => set({ messages }),
      // A new user message starts a fresh turn (drop any stale steps); a new
      // assistant answer adopts the steps accumulated while it was generated.
      addMessage: (message) => set((state) => {
        if (message.isUser) {
          return { messages: [...state.messages, message], agentSteps: [] };
        }
        const adoptSteps = !message.writeReview && state.agentSteps.length > 0;
        return {
          messages: [...state.messages, adoptSteps ? { ...message, agentSteps: state.agentSteps } : message],
          agentSteps: adoptSteps ? [] : state.agentSteps,
        };
      }),
      appendToLastMessage: (content) => set((state) => {
        const msgs = [...state.messages];
        if (msgs.length > 0 && !msgs[msgs.length - 1].isUser) {
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + content };
          return { messages: msgs };
        }
        const adoptSteps = state.agentSteps.length > 0;
        msgs.push(adoptSteps ? { content, isUser: false, agentSteps: state.agentSteps } : { content, isUser: false });
        return { messages: msgs, agentSteps: adoptSteps ? [] : state.agentSteps };
      }),
      addAgentStep: (step) => set((state) => ({ agentSteps: [...state.agentSteps, step] })),
      clearMessages: () => set({ messages: [] }),
      setInputValue: (inputValue) => set({ inputValue }),
      setIsLoading: (isLoading) => set({ isLoading }),
      setIsStreaming: (isStreaming) => set({ isStreaming }),
      setShowTips: (showTips) => set({ showTips }),
      setCurrentSessionId: (currentSessionId) => set({ currentSessionId }),
      setHistoryList: (historyList) => set({ historyList }),
      setContextSelection: (contextSelection) => set({ contextSelection }),
      setStatusText: (statusText) => set({ statusText }),
      setWriteReviewDecision: (reviewId, decision) => set((state) => ({
        messages: state.messages.map((m) =>
          m.writeReview?.id === reviewId ? { ...m, writeReview: { ...m.writeReview, decision } } : m
        ),
      })),
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