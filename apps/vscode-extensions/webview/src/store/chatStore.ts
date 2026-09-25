import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { VSCodeAPI } from '../vscode';
import { STORAGE_KEYS } from '../constants';
import { MESSAGE_TYPES } from '../constants';
import type { ChatAttachment } from '../constants';

/** A proposed agent action awaiting (or past) user review — file write or command. */
export interface WriteReview {
  id: string;
  kind: 'edit' | 'create' | 'delete' | 'command' | 'confluence-edit' | 'confluence-create';
  /** A workspace path — or, for a Confluence write, where it lands ("D2C › Parent › Title"). */
  path: string;
  summary: string;
  diff: { added: number; removed: number; text: string };
  /** The shell command, when kind === 'command'. */
  command?: string;
  /** The Confluence page (or parent page) a Confluence write opens to. */
  url?: string;
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
  /**
   * search | read | check | edit | command | thought | note | info | notice |
   * ticket. 'notice' and 'ticket' are the kinds rendered outside the
   * collapsible timeline — a notice carries something the user has to see
   * (e.g. an explicit context selection that could not be honored), a ticket
   * is the work item this run was grounded in, as a clickable chip.
   */
  kind: string;
  /** Verb-first label, e.g. "Searched", "Analyzed", "Edited". */
  title: string;
  /** Payload after the title: query text, "#L150-250", command string, or note prose. */
  detail?: string;
  /** Workspace-relative path when the step targets a file/dir (clickable). */
  path?: string;
  /** External http(s) target — set on 'ticket' steps, opened in the browser. */
  url?: string;
  status?: 'running' | 'done' | 'error';
  /** Result phrase once completed: "28 results", "+2 −2", "exit 0". */
  summary?: string;
  /** Extra completion data, e.g. { output, exitCode, durationMs } for commands. */
  meta?: { output?: string; exitCode?: number | null; durationMs?: number };
}

export const normalizeAgentStep = (step: AgentStep | string): AgentStep =>
  typeof step === 'string' ? { kind: 'info', title: step, status: 'done' } : step;

/** One id a run's tools returned, and what it refers to (host: services/agent/referenceIndex.ts). */
export interface RunRef {
  id: string;
  kind: 'work-item' | 'pull-request' | 'commit';
  url?: string;
  label?: string;
}

/** End-of-turn rollup: how long the agent worked and which files changed. */
export interface TurnSummary {
  durationMs: number;
  /** Tokens this turn spent, when known (remote mode only) — used to estimate the credits it cost. */
  promptTokens?: number;
  completionTokens?: number;
  filesChanged: { path: string; kind: 'edit' | 'create' | 'delete'; added: number; removed: number }[];
  /** Sha of the checkpoint taken before this turn's first change — undo target for the triggering user message. */
  checkpointSha?: string;
  /** The ADO ticket this turn was grounded in, if any — "Create PR" comments the report on it. */
  ticketId?: string;
  /**
   * What each id this turn's tools returned actually refers to, so the answer's
   * `#12359` links to the pull request it came from rather than to a work item
   * that happens to share the number. Absent on messages from before the run
   * recorded it, and on turns that returned no ids.
   */
  refs?: RunRef[];
  /** The ticket's work item type (e.g. "Bug", "Feature") — picks the branch's Conventional Commits prefix. */
  ticketType?: string;
  /** Commit/PR title, precomputed host-side (ticket title, else the answer's first heading). */
  title?: string;
  /** True when the host holds this turn's changes ready to branch/commit/push. */
  shippable?: boolean;
  /**
   * Outcome once "Create PR" has shipped this turn. Lives on the persisted
   * message so a reload shows the pushed branch, not a fresh "Create PR".
   */
  shipped?: ShippedTurn;
}

export interface ShippedTurn {
  branch: string;
  prUrl?: string;
  ticketCommented: boolean;
}

interface Message {
  content: string;
  isUser: boolean;
  isError?: boolean;
  /** Files/images the user attached to this message. */
  attachments?: ChatAttachment[];
  /** Workspace paths the user @-mentioned — re-resolved host-side on retry. */
  mentions?: string[];
  writeReview?: WriteReview;
  /** Tool-exploration steps the agent took before producing this answer. */
  agentSteps?: (AgentStep | string)[];
  /** Duration + files-changed rollup for the agent turn that produced this answer. */
  turnSummary?: TurnSummary;
  /** When this message was added — shown on hover for user messages. */
  timestamp?: number;
  /**
   * Error bubbles only: the interrupted run the host is still holding, so the
   * card can offer to resume it rather than leaving the user to guess that
   * typing "continue" would recover the work.
   *
   * Cleared when a new user turn supersedes the error (see
   * `supersedeTrailingError`). Until then it is persisted with the message,
   * because the host parks the transcript on disk — a run interrupted last
   * night is still resumable this morning. A record that has since been
   * pruned or already resumed degrades harmlessly: the click becomes an
   * ordinary continuation turn.
   */
  resumable?: { steps: number; writesApplied?: number };
}

interface ChatSessionPreview {
  id: string;
  title: string;
  updatedAt: number;
  /** Which mode the chat was held in. Absent on sessions saved before the Chat/Work switch — those read as 'work'. */
  assistantMode?: 'chat' | 'work';
}

/**
 * The turn-scoped fields every chat session carries. The visible session
 * keeps them at the top level of the store (so components stay unchanged);
 * sessions running in the background keep theirs in `liveSessions`.
 */
export interface LiveSession {
  messages: Message[];
  isLoading: boolean;
  isStreaming: boolean;
  statusText: string;
  agentSteps: AgentStep[];
  pendingTurnSummary: TurnSummary | null;
}

/** One named part of the prompt, as the worker weighed it (contextBreakdown.ts). */
export interface ContextSegment {
  key: string;
  label: string;
  tokens: number;
}

/**
 * A context-window reading for one session: the provider's measured
 * occupancy, plus the split of it the worker derived.
 *
 * Keyed BY SESSION rather than held as one live value, because a run keeps
 * going while the user reads another chat: a single value meant a background
 * run's numbers overwrote the visible meter, and coming back to a session
 * showed 0% for a conversation that was in fact nearly full.
 */
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  usedPct: number;
  remainingPct: number;
  /** How many times this run has truncated a tool result to free room. */
  compactions: number;
  segments?: ContextSegment[];
}

/** The subset of session state the turn reducers below operate on. */
interface TurnSlice {
  messages: Message[];
  agentSteps: AgentStep[];
  pendingTurnSummary: TurnSummary | null;
}

// ── Pure turn reducers ──────────────────────────────────────────────────────
// One implementation of the adoption rules (steps + turn rollup attach to the
// assistant answer they belong to), shared by the visible session's actions
// and the background-session variants.

/**
 * Visible work already on an error card — the timeline / files-changed bar
 * the user can still learn from. A 404 that never started a turn has neither,
 * and should vanish the moment they send another message. Host-held resume
 * state without UI steps is not enough to keep the red banner: continue
 * already reloads that transcript host-side.
 */
const trailingErrorHasVisibleWork = (message: Message): boolean =>
  (message.agentSteps?.length ?? 0) > 0 || (message.turnSummary?.filesChanged?.length ?? 0) > 0;

/**
 * A new user turn means the last error is no longer the live failure. Drop a
 * no-work error entirely; keep a turn that actually ran as a normal timeline
 * card so the red banner (and Resume) do not sit in the middle of the thread.
 */
const supersedeTrailingError = (messages: Message[]): Message[] => {
  const last = messages[messages.length - 1];
  if (!last?.isError) return messages;
  if (!trailingErrorHasVisibleWork(last)) return messages.slice(0, -1);
  return [
    ...messages.slice(0, -1),
    { ...last, isError: undefined, resumable: undefined, content: 'Turn interrupted.' },
  ];
};

/** A new user message starts a fresh turn; an assistant answer adopts accumulated steps. */
const addMessageIn = (s: TurnSlice, message: Message): TurnSlice => {
  if (message.isUser) {
    const stamped = { ...message, timestamp: message.timestamp ?? Date.now() };
    return {
      messages: [...supersedeTrailingError(s.messages), stamped],
      agentSteps: [],
      pendingTurnSummary: null,
    };
  }
  const adopt = !message.writeReview && (s.agentSteps.length > 0 || !!s.pendingTurnSummary);
  return {
    messages: [
      ...s.messages,
      adopt
        ? {
            ...message,
            ...(s.agentSteps.length > 0 ? { agentSteps: s.agentSteps } : {}),
            ...(s.pendingTurnSummary ? { turnSummary: s.pendingTurnSummary } : {}),
          }
        : message,
    ],
    agentSteps: adopt ? [] : s.agentSteps,
    pendingTurnSummary: adopt ? null : s.pendingTurnSummary,
  };
};

const appendToLastIn = (s: TurnSlice, content: string): TurnSlice => {
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];
  if (msgs.length > 0 && !last.isUser && !last.writeReview) {
    // Adopt a rollup that arrived after this message was created.
    msgs[msgs.length - 1] = {
      ...last,
      content: last.content + content,
      ...(!last.turnSummary && s.pendingTurnSummary ? { turnSummary: s.pendingTurnSummary } : {}),
    };
    return {
      messages: msgs,
      agentSteps: s.agentSteps,
      pendingTurnSummary: !last.turnSummary && s.pendingTurnSummary ? null : s.pendingTurnSummary,
    };
  }
  return addMessageIn(s, { content, isUser: false });
};

/**
 * Blank the last assistant message's text, keeping its timeline and summary.
 *
 * For the superseding second report of a single turn (see
 * RECEIVE_MESSAGE_RESTART): the steps belong to the whole turn and must
 * survive, but the first report's prose is now wrong — it says nothing was
 * changed about a turn that went on to change files.
 */
const restartLastIn = (s: TurnSlice): TurnSlice => {
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];
  if (!last || last.isUser || last.writeReview) return s;
  msgs[msgs.length - 1] = { ...last, content: '' };
  return { ...s, messages: msgs };
};

const setTurnSummaryIn = (s: TurnSlice, summary: TurnSummary): TurnSlice => {
  const msgs = [...s.messages];
  const last = msgs[msgs.length - 1];
  if (last && !last.isUser && !last.writeReview && !last.isError) {
    msgs[msgs.length - 1] = { ...last, turnSummary: summary };
    return { ...s, messages: msgs };
  }
  return { ...s, pendingTurnSummary: summary };
};

/** Stamp `shipped` on the last shippable turn in a message list; unchanged list when there is none. */
const markShippedIn = (messages: Message[], shipped: ShippedTurn): Message[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.isUser || !m.turnSummary?.shippable) continue;
    const msgs = [...messages];
    msgs[i] = { ...m, turnSummary: { ...m.turnSummary, shippable: false, shipped } };
    return msgs;
  }
  return messages;
};

/** End-of-turn safety net: returns null when there is nothing unattached to materialize. */
const finalizeIn = (s: TurnSlice, fallbackContent: string): TurnSlice | null => {
  if (s.agentSteps.length === 0 && !s.pendingTurnSummary) return null;
  return {
    messages: [
      ...s.messages,
      {
        content: fallbackContent,
        isUser: false,
        ...(s.agentSteps.length > 0 ? { agentSteps: s.agentSteps } : {}),
        ...(s.pendingTurnSummary ? { turnSummary: s.pendingTurnSummary } : {}),
      },
    ],
    agentSteps: [],
    pendingTurnSummary: null,
  };
};

const closePendingReviewsIn = (messages: Message[]): Message[] =>
  messages.map((m) =>
    m.writeReview && !m.writeReview.decision
      ? { ...m, writeReview: { ...m.writeReview, decision: 'rejected' as const } }
      : m
  );

interface ChatState {
  messages: Message[];
  inputValue: string;
  isLoading: boolean;
  isStreaming: boolean;
  showTips: boolean;
  currentSessionId: string | null;
  historyList: ChatSessionPreview[];
  contextSelection: string;
  /**
   * Chat/Work switch. 'work' (default) can draw on Confluence, Azure DevOps
   * and the codebase; 'chat' is a plain conversation that touches none of
   * them. Persisted the same way as `contextSelection` — a session-wide
   * choice, not per-message.
   */
  assistantMode: 'chat' | 'work';
  statusText: string;
  /** Steps accumulated for the in-flight turn; attached to the next assistant message. */
  agentSteps: AgentStep[];
  /** Turn rollup received before the answer message existed; adopted on attach. */
  pendingTurnSummary: TurnSummary | null;
  /**
   * Sessions with a run in flight (or just finished) that are NOT on screen.
   * Keyed by sessionId. An entry is created by stashing the visible session
   * away and consumed by activating it again; host messages for these
   * sessions are applied here instead of to the visible chat.
   */
  liveSessions: Record<string, LiveSession>;
  /**
   * Last context-window reading per session, visible or backgrounded. Outlives
   * `liveSessions` entries on purpose: those are consumed when a session is
   * opened, but the meter must survive switching back and forth.
   */
  sessionContext: Record<string, ContextUsage>;
  /** `tokens_per_credit` from the signed-in account's profile — null until sign-in resolves. Used to turn a turn's tokens into an estimated credit cost. */
  tokensPerCredit: number | null;
  setTokensPerCredit: (tokensPerCredit: number | null) => void;
  setMessages: (messages: Message[]) => void;
  addMessage: (message: Message) => void;
  /** Drop one message by index — used to clear a failed turn's error bubble before retrying it. */
  removeMessageAt: (index: number) => void;
  /**
   * Drop the message at `index` and everything after it. Backs the "edit an
   * earlier message" flow: the edited turn and every answer that followed from
   * the old wording are discarded, so the conversation forks cleanly instead of
   * carrying a reply to a question that is no longer on screen.
   */
  truncateFrom: (index: number) => void;
  appendToLastMessage: (content: string) => void;
  restartLastMessage: () => void;
  addAgentStep: (step: AgentStep) => void;
  updateAgentStep: (id: string, patch: Partial<AgentStep>) => void;
  setTurnSummary: (summary: TurnSummary) => void;
  /**
   * Record a successful "Create PR" on the session's latest shippable turn
   * (visible chat or a backgrounded one) — flips it to shipped so the bar
   * shows the outcome and no other Create PR button competes for it.
   */
  markTurnShipped: (sessionId: string | null, shipped: ShippedTurn) => void;
  /**
   * End-of-turn safety net: if steps/summary are still unattached (the model
   * returned no text), materialize an assistant message so the work done is
   * never invisible. Returns without effect when a normal answer already landed.
   */
  finalizeAgentTurn: (fallbackContent: string) => void;
  /**
   * Drops the in-flight turn's unattached steps/rollup. Used when a turn is
   * abandoned (new chat, switching to a history session) so its steps can't
   * later attach themselves to a message in a different conversation.
   */
  resetTurnState: () => void;
  /** Park the visible session's live state under its id (background it). */
  stashCurrentSession: () => void;
  /** Promote a backgrounded session to the visible one. False if not present. */
  activateLiveSession: (sessionId: string) => boolean;
  /** Forget a backgrounded session (deleted, or consumed elsewhere). */
  dropLiveSession: (sessionId: string) => void;
  /** Record (or clear, with null) one session's context reading. */
  setSessionContext: (sessionId: string | null, usage: ContextUsage | null) => void;
  // Background-session variants of the turn actions — same reducers, applied
  // to liveSessions[sessionId]. All no-op if the session isn't backgrounded.
  bgAddMessage: (sessionId: string, message: Message) => void;
  bgAppendToLast: (sessionId: string, content: string) => void;
  bgRestartLast: (sessionId: string) => void;
  bgAddAgentStep: (sessionId: string, step: AgentStep) => void;
  bgUpdateAgentStep: (sessionId: string, id: string, patch: Partial<AgentStep>) => void;
  bgSetTurnSummary: (sessionId: string, summary: TurnSummary) => void;
  bgFinalizeTurn: (sessionId: string, fallbackContent: string) => void;
  bgPatch: (sessionId: string, patch: Partial<Pick<LiveSession, 'isLoading' | 'isStreaming' | 'statusText'>>) => void;
  bgCloseAllPendingWriteReviews: (sessionId: string) => void;
  clearMessages: () => void;
  setInputValue: (value: string) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsStreaming: (isStreaming: boolean) => void;
  setShowTips: (showTips: boolean) => void;
  setCurrentSessionId: (id: string | null) => void;
  setHistoryList: (list: ChatSessionPreview[]) => void;
  setContextSelection: (selection: string) => void;
  setAssistantMode: (mode: 'chat' | 'work') => void;
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
  assistantMode: 'work' as const,
  statusText: '',
  agentSteps: [],
  pendingTurnSummary: null,
  liveSessions: {},
  sessionContext: {},
  tokensPerCredit: null,
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      ...chatDefaultState,
      setMessages: (messages) => set({ messages }),
      // A new user message starts a fresh turn (drop any stale steps); a new
      // assistant answer adopts the steps + turn rollup accumulated while it
      // was generated.
      addMessage: (message) => set((state) => addMessageIn(state, message)),
      removeMessageAt: (index) => set((state) => ({
        messages: state.messages.filter((_, i) => i !== index),
      })),
      truncateFrom: (index) => set((state) => ({
        messages: state.messages.slice(0, index),
        // The discarded tail may have owned the in-flight turn's steps/rollup;
        // they must not attach themselves to the re-asked turn's answer.
        agentSteps: [],
        pendingTurnSummary: null,
      })),
      appendToLastMessage: (content) => set((state) => appendToLastIn(state, content)),
      restartLastMessage: () => set((state) => restartLastIn(state)),
      addAgentStep: (step) => set((state) => ({ agentSteps: [...state.agentSteps, step] })),
      updateAgentStep: (id, patch) => set((state) => ({
        agentSteps: state.agentSteps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      })),
      // Attach directly when the answer message already exists; otherwise park
      // it for adoption by the next assistant message.
      setTurnSummary: (summary) => set((state) => setTurnSummaryIn(state, summary)),
      markTurnShipped: (sessionId, shipped) => set((state) => {
        if (!sessionId || sessionId === state.currentSessionId) {
          return { messages: markShippedIn(state.messages, shipped) };
        }
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, messages: markShippedIn(entry.messages, shipped) } } };
      }),
      finalizeAgentTurn: (fallbackContent) => set((state) => finalizeIn(state, fallbackContent) ?? {}),
      resetTurnState: () => set({ agentSteps: [], pendingTurnSummary: null }),
      stashCurrentSession: () => set((state) => {
        if (!state.currentSessionId) return {};
        // Only a session with a run in flight needs live state parked — an
        // idle session's messages are already persisted to history.
        if (!state.isLoading && !state.isStreaming) return {};
        return {
          liveSessions: {
            ...state.liveSessions,
            [state.currentSessionId]: {
              messages: state.messages,
              isLoading: state.isLoading,
              isStreaming: state.isStreaming,
              statusText: state.statusText,
              agentSteps: state.agentSteps,
              pendingTurnSummary: state.pendingTurnSummary,
            },
          },
        };
      }),
      activateLiveSession: (sessionId) => {
        const entry = get().liveSessions[sessionId];
        if (!entry) return false;
        set((state) => {
          const { [sessionId]: _consumed, ...rest } = state.liveSessions;
          return {
            currentSessionId: sessionId,
            messages: entry.messages,
            isLoading: entry.isLoading,
            isStreaming: entry.isStreaming,
            statusText: entry.statusText,
            agentSteps: entry.agentSteps,
            pendingTurnSummary: entry.pendingTurnSummary,
            showTips: false,
            liveSessions: rest,
          };
        });
        return true;
      },
      dropLiveSession: (sessionId) => set((state) => {
        if (!state.liveSessions[sessionId]) return {};
        const { [sessionId]: _dropped, ...rest } = state.liveSessions;
        return { liveSessions: rest };
      }),
      setSessionContext: (sessionId, usage) => set((state) => {
        if (!sessionId) return {};
        if (!usage) {
          if (!state.sessionContext[sessionId]) return {};
          const { [sessionId]: _cleared, ...rest } = state.sessionContext;
          return { sessionContext: rest };
        }
        return { sessionContext: { ...state.sessionContext, [sessionId]: usage } };
      }),
      bgAddMessage: (sessionId, message) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, ...addMessageIn(entry, message) } } };
      }),
      bgAppendToLast: (sessionId, content) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, ...appendToLastIn(entry, content) } } };
      }),
      bgRestartLast: (sessionId) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, ...restartLastIn(entry) } } };
      }),
      bgAddAgentStep: (sessionId, step) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return {
          liveSessions: {
            ...state.liveSessions,
            [sessionId]: { ...entry, agentSteps: [...entry.agentSteps, step] },
          },
        };
      }),
      bgUpdateAgentStep: (sessionId, id, patch) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return {
          liveSessions: {
            ...state.liveSessions,
            [sessionId]: {
              ...entry,
              agentSteps: entry.agentSteps.map((st) => (st.id === id ? { ...st, ...patch } : st)),
            },
          },
        };
      }),
      bgSetTurnSummary: (sessionId, summary) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, ...setTurnSummaryIn(entry, summary) } } };
      }),
      bgFinalizeTurn: (sessionId, fallbackContent) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        const last = entry.messages[entry.messages.length - 1];
        // Same rule as the visible session's DONE handler: only materialize a
        // fallback answer when the turn produced no assistant text.
        if (last && !last.isUser && !last.writeReview) return {};
        const finalized = finalizeIn(entry, fallbackContent);
        if (!finalized) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, ...finalized } } };
      }),
      bgPatch: (sessionId, patch) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return { liveSessions: { ...state.liveSessions, [sessionId]: { ...entry, ...patch } } };
      }),
      bgCloseAllPendingWriteReviews: (sessionId) => set((state) => {
        const entry = state.liveSessions[sessionId];
        if (!entry) return {};
        return {
          liveSessions: {
            ...state.liveSessions,
            [sessionId]: { ...entry, messages: closePendingReviewsIn(entry.messages) },
          },
        };
      }),
      clearMessages: () => set({ messages: [], agentSteps: [], pendingTurnSummary: null }),
      setInputValue: (inputValue) => set({ inputValue }),
      setIsLoading: (isLoading) => set({ isLoading }),
      setIsStreaming: (isStreaming) => set({ isStreaming }),
      setShowTips: (showTips) => set({ showTips }),
      setCurrentSessionId: (currentSessionId) => set({ currentSessionId }),
      setHistoryList: (historyList) => set({ historyList }),
      setContextSelection: (contextSelection) => set({ contextSelection }),
      setAssistantMode: (assistantMode) => set({ assistantMode }),
      setStatusText: (statusText) => set({ statusText }),
      setTokensPerCredit: (tokensPerCredit) => set({ tokensPerCredit }),
      setWriteReviewDecision: (reviewId, decision) => set((state) => ({
        messages: state.messages.map((m) =>
          m.writeReview?.id === reviewId ? { ...m, writeReview: { ...m.writeReview, decision } } : m
        ),
      })),
      // Stop/worker-death auto-rejects every parked gate host-side; mirror
      // that on any card still showing live buttons.
      closeAllPendingWriteReviews: () => set((state) => ({
        messages: closePendingReviewsIn(state.messages),
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
      // Live runs can't survive the webview being torn down (the host's
      // stream has nowhere to land) — don't resurrect their spinners.
      partialize: (state) =>
        Object.fromEntries(
          Object.entries(state).filter(([key]) => key !== 'liveSessions')
        ) as ChatState,
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<ChatState>),
        liveSessions: {},
        isLoading: false,
        isStreaming: false,
        statusText: '',
      }),
    }
  )
);

/** Live chat fields copied between the sidebar and editor-tab webviews. */
export function collectChatSnapshot() {
  const s = useChatStore.getState();
  return {
    messages: s.messages,
    inputValue: s.inputValue,
    isLoading: s.isLoading,
    isStreaming: s.isStreaming,
    showTips: s.showTips,
    currentSessionId: s.currentSessionId,
    historyList: s.historyList,
    contextSelection: s.contextSelection,
    assistantMode: s.assistantMode,
    statusText: s.statusText,
    agentSteps: s.agentSteps,
    pendingTurnSummary: s.pendingTurnSummary,
    liveSessions: s.liveSessions,
    sessionContext: s.sessionContext,
  };
}

export function applyChatSnapshot(
  snapshot: Partial<ReturnType<typeof collectChatSnapshot>> | undefined
): void {
  if (!snapshot || typeof snapshot !== 'object') return;
  useChatStore.setState({
    messages: snapshot.messages ?? [],
    inputValue: snapshot.inputValue ?? '',
    isLoading: !!snapshot.isLoading,
    isStreaming: !!snapshot.isStreaming,
    showTips: snapshot.showTips ?? (snapshot.messages?.length ?? 0) === 0,
    currentSessionId: snapshot.currentSessionId ?? null,
    historyList: snapshot.historyList ?? [],
    contextSelection: snapshot.contextSelection ?? 'Auto',
    assistantMode: snapshot.assistantMode ?? 'work',
    statusText: snapshot.statusText ?? '',
    agentSteps: snapshot.agentSteps ?? [],
    pendingTurnSummary: snapshot.pendingTurnSummary ?? null,
    liveSessions: snapshot.liveSessions ?? {},
    sessionContext: snapshot.sessionContext ?? {},
  });
}