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

/**
 * One structured agent-timeline step. Older saved sessions persisted steps as
 * plain strings — normalize with `normalizeAgentStep` before rendering.
 */
export interface AgentStep {
  /** Correlates start → completion updates; absent for one-shot steps (thought/note/info). */
  id?: string;
  /** search | read | check | edit | command | thought | note | info. */
  kind: string;
  /** Verb-first label, e.g. "Searched", "Analyzed", "Edited". */
  title: string;
  /** Payload after the title: query text, "#L150-250", command string, or note prose. */
  detail?: string;
  /** Workspace-relative path when the step targets a file/dir (clickable). */
  path?: string;
  status?: 'running' | 'done' | 'error';
  /** Result phrase once completed: "28 results", "+2 −2", "exit 0". */
  summary?: string;
  /** Extra completion data, e.g. { output, exitCode, durationMs } for commands. */
  meta?: { output?: string; exitCode?: number | null; durationMs?: number };
}

export const normalizeAgentStep = (step: AgentStep | string): AgentStep =>
  typeof step === 'string' ? { kind: 'info', title: step, status: 'done' } : step;

/** End-of-turn rollup: how long the agent worked and which files changed. */
export interface TurnSummary {
  durationMs: number;
  filesChanged: { path: string; kind: 'edit' | 'create' | 'delete'; added: number; removed: number }[];
  /** Sha of the checkpoint taken before this turn's first change — undo target for the triggering user message. */
  checkpointSha?: string;
}

interface Message {
  content: string;
  isUser: boolean;
  isError?: boolean;
  writeReview?: WriteReview;
  /** Tool-exploration steps the agent took before producing this answer. */
  agentSteps?: (AgentStep | string)[];
  /** Duration + files-changed rollup for the agent turn that produced this answer. */
  turnSummary?: TurnSummary;
  /** When this message was added — shown on hover for user messages. */
  timestamp?: number;
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
  agentSteps: AgentStep[];
  /** Turn rollup received before the answer message existed; adopted on attach. */
  pendingTurnSummary: TurnSummary | null;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  /** Drop one message by index — used to clear a failed turn's error bubble before retrying it. */
  removeMessageAt: (index: number) => void;
  appendToLastMessage: (content: string) => void;
  addAgentStep: (step: AgentStep) => void;
  updateAgentStep: (id: string, patch: Partial<AgentStep>) => void;
  setTurnSummary: (summary: TurnSummary) => void;
  /**
   * End-of-turn safety net: if steps/summary are still unattached (the model
   * returned no text), materialize an assistant message so the work done is
   * never invisible. Returns without effect when a normal answer already landed.
   */
  finalizeAgentTurn: (fallbackContent: string) => void;
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
  closeAllPendingWriteReviews: () => void;
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
  pendingTurnSummary: null,
};

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      ...chatDefaultState,
      setMessages: (messages) => set({ messages }),
      // A new user message starts a fresh turn (drop any stale steps); a new
      // assistant answer adopts the steps + turn rollup accumulated while it
      // was generated.
      addMessage: (message) => set((state) => {
        if (message.isUser) {
          const stamped = { ...message, timestamp: message.timestamp ?? Date.now() };
          return { messages: [...state.messages, stamped], agentSteps: [], pendingTurnSummary: null };
        }
        const adopt = !message.writeReview && (state.agentSteps.length > 0 || !!state.pendingTurnSummary);
        return {
          messages: [
            ...state.messages,
            adopt
              ? {
                  ...message,
                  ...(state.agentSteps.length > 0 ? { agentSteps: state.agentSteps } : {}),
                  ...(state.pendingTurnSummary ? { turnSummary: state.pendingTurnSummary } : {}),
                }
              : message,
          ],
          agentSteps: adopt ? [] : state.agentSteps,
          pendingTurnSummary: adopt ? null : state.pendingTurnSummary,
        };
      }),
      removeMessageAt: (index) => set((state) => ({
        messages: state.messages.filter((_, i) => i !== index),
      })),
      appendToLastMessage: (content) => set((state) => {
        const msgs = [...state.messages];
        const last = msgs[msgs.length - 1];
        if (msgs.length > 0 && !last.isUser && !last.writeReview) {
          // Adopt a rollup that arrived after this message was created (the
          // summary lands before the typewriter pump finishes the message).
          msgs[msgs.length - 1] = {
            ...last,
            content: last.content + content,
            ...(!last.turnSummary && state.pendingTurnSummary ? { turnSummary: state.pendingTurnSummary } : {}),
          };
          return {
            messages: msgs,
            pendingTurnSummary: !last.turnSummary && state.pendingTurnSummary ? null : state.pendingTurnSummary,
          };
        }
        const adopt = state.agentSteps.length > 0 || !!state.pendingTurnSummary;
        msgs.push(
          adopt
            ? {
                content,
                isUser: false,
                ...(state.agentSteps.length > 0 ? { agentSteps: state.agentSteps } : {}),
                ...(state.pendingTurnSummary ? { turnSummary: state.pendingTurnSummary } : {}),
              }
            : { content, isUser: false }
        );
        return {
          messages: msgs,
          agentSteps: adopt ? [] : state.agentSteps,
          pendingTurnSummary: adopt ? null : state.pendingTurnSummary,
        };
      }),
      addAgentStep: (step) => set((state) => ({ agentSteps: [...state.agentSteps, step] })),
      updateAgentStep: (id, patch) => set((state) => ({
        agentSteps: state.agentSteps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      })),
      // Attach directly when the answer message already exists; otherwise park
      // it for adoption by the next assistant message.
      setTurnSummary: (summary) => set((state) => {
        const msgs = [...state.messages];
        const last = msgs[msgs.length - 1];
        if (last && !last.isUser && !last.writeReview && !last.isError) {
          msgs[msgs.length - 1] = { ...last, turnSummary: summary };
          return { messages: msgs };
        }
        return { pendingTurnSummary: summary };
      }),
      finalizeAgentTurn: (fallbackContent) => set((state) => {
        if (state.agentSteps.length === 0 && !state.pendingTurnSummary) return {};
        const msgs = [...state.messages];
        return {
          messages: [
            ...msgs,
            {
              content: fallbackContent,
              isUser: false,
              ...(state.agentSteps.length > 0 ? { agentSteps: state.agentSteps } : {}),
              ...(state.pendingTurnSummary ? { turnSummary: state.pendingTurnSummary } : {}),
            },
          ],
          agentSteps: [],
          pendingTurnSummary: null,
        };
      }),
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
      // Stop/worker-death auto-rejects every parked gate host-side; mirror
      // that on any card still showing live buttons.
      closeAllPendingWriteReviews: () => set((state) => ({
        messages: state.messages.map((m) =>
          m.writeReview && !m.writeReview.decision
            ? { ...m, writeReview: { ...m.writeReview, decision: 'rejected' as const } }
            : m
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