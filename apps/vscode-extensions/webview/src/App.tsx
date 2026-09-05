import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import './App.css';
import ChatMessage from './components/ChatMessage';
import AgentWriteCard, { REVIEW_KIND_LABEL } from './components/AgentWriteCard';
import AgentTimeline from './components/AgentTimeline';
import ChatHistorySidebar from './components/ChatHistorySidebar';
import MentionPicker from './components/MentionPicker';
import MyWorkPanel, { WorkItemSummary } from './components/MyWorkPanel';
import HomeGreeting from './components/HomeGreeting';
import QuickTipsSection from './components/QuickTipsSection';
import GitStatusBar from './components/GitStatusBar';
import CreatePrButton from './components/CreatePrButton';
import UsageLimitBar from './components/UsageLimitBar';
import { useGitStatusSync } from './hooks/useGitStatusSync';
import { displaySessionTitle, formatRelativeTime } from './utils/sessionTitle';
import SettingsButton from './components/Settings';
import Releases from './components/Releases';
import Onboarding from './components/onboarding/Onboarding';
import SearchableDropdown from './components/settings/SearchableDropdown';
import type { DropdownOption } from './components/settings/SearchableDropdown';
import { VSCodeAPI } from './vscode';
import {
  setModelState,
  useChatStore,
  collectChatSnapshot,
  applyChatSnapshot,
  useModelActions,
  useModelProviders,
  useSelectedModelProvider,
  useSettingsStore,
  useUiStore,
} from './store';
import { modelDefaultConfig } from './store/modelStore';
// The word the Resume button sends, defined next to the patterns the host
// parses it with — see continuationIntent's header for why it must be bare.
import { RESUME_MESSAGE } from '../../src/utils/continuationIntent';
import { MESSAGE_TYPES, STORAGE_KEYS, ATTACHMENT_LIMITS } from './constants';
import type { ChatAttachment, MentionTarget } from './constants';
import { settingsDefaultConfig } from './store/settingsStore';

function initialChatLayout(): 'sidebar' | 'editor' {
  return window.__WGPT_CHAT_LAYOUT__ === 'editor' ? 'editor' : 'sidebar';
}

// Simple UUID generator (no external dep needed)
function generateSessionId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** File extensions we confidently treat as inline-able text when the browser reports no mime type. */
const TEXT_FILE_EXTENSIONS = /\.(txt|md|markdown|json|jsonc|yaml|yml|xml|html|htm|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|swift|php|sql|sh|bash|zsh|ps1|bat|toml|ini|cfg|conf|env|log|csv|tsv|properties|gradle|tf|proto|graphql|vue|svelte|dockerfile|makefile|lock)$/i;

/**
 * Context-picker row for Confluence / Azure DevOps. Uses the same live
 * sync/index fields Settings already receives, so the menu updates while open.
 */
function knowledgeContextOption(
  value: string,
  label: string,
  source: {
    isAuthenticated?: boolean;
    isSyncing?: boolean;
    isIndexing?: boolean;
    isIndexingCompleted?: boolean;
    canResume?: boolean;
    canResumeIndexing?: boolean;
    syncProgress: number;
    indexProgress: number;
  }
): DropdownOption {
  const canQuery = !!(source.isAuthenticated && source.isIndexingCompleted);
  if (!source.isAuthenticated) {
    return {
      value,
      label,
      disabled: true,
      subtitle: 'Not connected — connect it in Settings',
    };
  }

  if (source.isSyncing) {
    const progress = Math.max(0, Math.min(100, Math.round(source.syncProgress || 0)));
    return {
      value,
      label,
      disabled: !canQuery,
      subtitle: `Syncing… ${progress}%`,
      progress,
    };
  }

  if (source.isIndexing) {
    const progress = Math.max(0, Math.min(100, Math.round(source.indexProgress || 0)));
    return {
      value,
      label,
      disabled: !canQuery,
      subtitle: `Indexing… ${progress}%`,
      progress,
    };
  }

  if (canQuery) {
    return { value, label };
  }

  return {
    value,
    label,
    disabled: true,
    subtitle:
      source.canResume || source.canResumeIndexing
        ? 'Paused — finish the sync in Settings'
        : 'Indexing unfinished — finish the sync in Settings',
  };
}

const isTextLike = (file: File): boolean =>
  file.type.startsWith('text/') ||
  ['application/json', 'application/xml', 'application/x-yaml', 'application/javascript', 'application/typescript'].includes(file.type) ||
  TEXT_FILE_EXTENSIONS.test(file.name);

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

/**
 * Converts picked/pasted/dropped files into ChatAttachments, enforcing the
 * per-message limits. Returns the attachments plus a human-readable note for
 * anything skipped (unsupported type / too large / over the count cap).
 */
async function filesToAttachments(
  files: File[],
  existingCount: number
): Promise<{ attachments: ChatAttachment[]; skippedNote: string | null }> {
  const attachments: ChatAttachment[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (existingCount + attachments.length >= ATTACHMENT_LIMITS.MAX_FILES) {
      skipped.push(`${file.name} (max ${ATTACHMENT_LIMITS.MAX_FILES} attachments)`);
      continue;
    }
    try {
      if (file.type.startsWith('image/')) {
        if (file.size > ATTACHMENT_LIMITS.MAX_IMAGE_BYTES) {
          skipped.push(`${file.name} (image over ${Math.round(ATTACHMENT_LIMITS.MAX_IMAGE_BYTES / 1024 / 1024)}MB)`);
          continue;
        }
        attachments.push({
          name: file.name || 'pasted-image.png',
          mimeType: file.type,
          kind: 'image',
          content: await readFileAsDataUrl(file),
          size: file.size,
        });
      } else if (isTextLike(file)) {
        let text = await readFileAsText(file);
        if (text.length > ATTACHMENT_LIMITS.MAX_TEXT_CHARS) {
          text = text.slice(0, ATTACHMENT_LIMITS.MAX_TEXT_CHARS) + '\n\n[... truncated ...]';
        }
        attachments.push({
          name: file.name,
          mimeType: file.type || 'text/plain',
          kind: 'text',
          content: text,
          size: file.size,
        });
      } else {
        skipped.push(`${file.name} (only images and text files are supported)`);
      }
    } catch {
      skipped.push(`${file.name} (could not read file)`);
    }
  }
  return { attachments, skippedNote: skipped.length ? `Skipped: ${skipped.join(', ')}` : null };
}

/**
 * The "@" token the caret currently sits in, if any. A mention starts at a
 * word boundary (so an email address or a decorator mid-word doesn't open the
 * picker) and runs to the caret. Paths may contain "/" and "." but never
 * whitespace, which is what ends the token.
 */
function findMentionToken(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/**
 * The mention paths still present in the composed message. Tracked separately
 * from the text because only paths the user actually picked from the picker
 * count — typing "@foo" by hand shouldn't make the host go read a file — and
 * because deleting the text of a mention must drop it from the message.
 */
function activeMentions(text: string, picked: Set<string>): string[] {
  return [...picked].filter((mentionPath) =>
    new RegExp(`(?:^|\\s)@${mentionPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![^\\s])`).test(text)
  );
}

/** Maps a raw host error onto the user-facing markdown bubble. */
function formatChatError(rawError: string): string {
  if (rawError.includes('403') && rawError.includes('subscription')) {
    const urlMatch = rawError.match(/https?:\/\/[^\s")]+/);
    const upgradeUrl = urlMatch ? urlMatch[0] : null;
    return `⚠️ **Access Denied (403):** This model requires a subscription.\n\n`
      + (upgradeUrl ? `Upgrade here: [${upgradeUrl}](${upgradeUrl})\n\n` : '')
      + `Please select a different model or upgrade your plan.`;
  }
  if (rawError.includes('401') || rawError.includes('Unauthorized')) {
    return `🔑 **Authentication Error:** Your API key appears to be invalid or expired. Please check your API key in Settings.`;
  }
  if (rawError.includes('429') || rawError.includes('rate limit')) {
    return `⏳ **Rate Limited:** Too many requests. Please wait a moment and try again.`;
  }
  if (rawError.includes('ECONNREFUSED') || rawError.includes('ENOTFOUND')) {
    return `🔌 **Connection Error:** Unable to reach the model provider. Please check that the service is running and your network connection is active.`;
  }
  return `❌ **Error:** ${rawError}`;
}

/**
 * Last-resort text for a turn that ended with steps but no prose, when the
 * host said nothing about what happened — only reachable against an extension
 * host predating `RECEIVE_MESSAGE_DONE.fallbackAnswer`, which now carries the
 * host's own truthful wording (see describeTurnOutcome).
 *
 * It must never claim work. The previous wording — "Done — see the steps above
 * for what was explored and changed" — reported a completed fix on a turn that
 * ran no tools and changed nothing (#1534774): the user read "Done", believed
 * the bug was fixed, and only found out by checking the diff.
 */
const AGENT_FALLBACK_ANSWER =
  'The model stopped without writing a summary — see the steps above for what this turn actually did.';

/** Host messages that belong to one session's in-flight turn (routable by sessionId). */
const TURN_SCOPED_TYPES = new Set<string>([
  MESSAGE_TYPES.RECEIVE_MESSAGE,
  MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK,
  MESSAGE_TYPES.RECEIVE_MESSAGE_DONE,
  MESSAGE_TYPES.RETRIEVAL_STATUS,
  MESSAGE_TYPES.AGENT_STEP,
  MESSAGE_TYPES.AGENT_STEP_UPDATE,
  MESSAGE_TYPES.AGENT_TURN_SUMMARY,
  MESSAGE_TYPES.AGENT_WRITE_REVIEW,
  MESSAGE_TYPES.AGENT_WRITE_REVIEWS_CLOSED,
  MESSAGE_TYPES.ERROR_CHAT,
]);

/**
 * Starter prompts double as positioning: the first two show the thing no other
 * coding agent does out of the box (ticket/doc context feeding a code task),
 * the rest cover plain codebase and doc questions. Keep the org-grounded ones
 * first — they're the reason someone picks this over Cursor/Claude Code.
 */
interface Suggestion {
  /** Short chip text the user reads. */
  label: string;
  /** The full prompt actually sent — the label is a handle, not the ask. */
  prompt: string;
}

/**
 * "Try asking" suggestions, grounded in what this workspace actually has.
 *
 * With tickets on screen, the useful suggestions are things the ticket list
 * can't do by itself — fix one, explain one, summarise the sprint — rather
 * than "show my tickets", which duplicated the panel directly above. Without
 * tickets, fall back to prompts that show the agent's reach across docs and
 * code.
 */
function buildSuggestions(
  items: WorkItemSummary[],
  sprintName: string | undefined,
  hasConfluence: boolean
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const [first, second] = items;

  if (first) {
    suggestions.push({
      label: `Fix #${first.id}`,
      prompt:
        `Work on ticket ${first.id} (${first.title}) — read the ticket and any design doc behind it, ` +
        'find the code it affects, then implement the fix. Show me the diffs as you go.',
    });
  }
  const explainTarget = second ?? first;
  if (explainTarget) {
    suggestions.push({
      label: `Explain #${explainTarget.id} and the code it touches`,
      prompt:
        `Read ticket ${explainTarget.id} (${explainTarget.title}), find the code it affects, ` +
        'and explain what would need to change and why. Do not edit anything yet.',
    });
  }
  if (items.length > 1) {
    suggestions.push({
      label: sprintName ? `Summarize my ${sprintName} tickets` : 'Summarize my open tickets',
      prompt:
        `Summarize the tickets assigned to me${sprintName ? ` in ${sprintName}` : ''}: ` +
        'group them by area, flag anything blocked or unclear, and suggest an order to tackle them.',
    });
  }
  if (hasConfluence) {
    suggestions.push({
      label: 'What do our docs say about the release process?',
      prompt: 'What do our docs say about the release process?',
    });
  }
  if (suggestions.length < 3) {
    suggestions.push({
      label: 'Explain the architecture of this project',
      prompt: 'Explain the architecture of this project',
    });
  }
  return suggestions.slice(0, 4);
}

const SuggestionArrow: React.FC = () => (
  <span className='prompt-item-arrow' aria-hidden='true'>
    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
      <path d='M9 6l6 6-6 6' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
    </svg>
  </span>
);

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
    removeMessageAt,
    truncateFrom,
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
    resetTurnState,
    liveSessions,
    stashCurrentSession,
    activateLiveSession,
    dropLiveSession,
  } = useChatStore();

  const {
    config,
    setConfig: setSettingsConfig,
  } = useSettingsStore();

  const { activeView, setActiveView, settingsHydrated, setSettingsHydrated } = useUiStore();

  const mode = config.mode;
  // Chat mode dial, cycled by the composer chip. Persisted per webview.
  // - agent (default): autonomous=true — edits apply without review cards
  //   (checkpointed + audited), permission-seeking is a failure, stalls
  //   auto-resume. Same dial the My Work ▶ button uses.
  // - plan: planMode=true — the turn's deliverable IS a plan (no writes);
  //   replying "go ahead" executes it via the existing approval handoff.
  // - ask: neither flag — every edit shows a review card (the old default).
  type ChatMode = 'agent' | 'plan' | 'ask';
  const CHAT_MODE_ORDER: ChatMode[] = ['agent', 'plan', 'ask'];
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    try {
      const saved = localStorage.getItem('wgpt.chatMode');
      return saved === 'plan' || saved === 'ask' ? saved : 'agent';
    } catch {
      return 'agent';
    }
  });
  const setChatModePersisted = (next: ChatMode) => {
    setChatMode(next);
    try {
      localStorage.setItem('wgpt.chatMode', next);
    } catch {
      /* private-mode storage failures are fine — the choice still holds for this session */
    }
  };
  // Every send path must carry the dial — a path that forgets it silently
  // downgrades the run to Ask mode (observed live: an Agent-mode ticket run
  // came back with slow-mode degradation and a command approval card, both of
  // which autonomous runs skip, because the send site omitted the flag).
  const modeFlags = () => ({
    ...(chatMode === 'agent' ? { autonomous: true } : {}),
    ...(chatMode === 'plan' ? { planMode: true } : {}),
  });
  const CHAT_MODE_META: Record<ChatMode, { label: string; title: string }> = {
    agent: {
      label: 'Agent',
      title: 'Agent: edits apply on their own, checkpointed so you can revert.',
    },
    plan: {
      label: 'Plan',
      title: 'Plan: investigates and proposes exact edits without changing anything. Reply "go ahead" to run it.',
    },
    ask: {
      label: 'Ask',
      title: 'Ask: every edit is shown as a diff for you to approve first.',
    },
  };
  const isConfluenceConnected = config.confluence?.isAuthenticated || false;
  // Gate on the org/project actually being present, not just `isAuthenticated`.
  // The webview store starts from defaults and is hydrated from globalState a
  // beat later; firing on the boolean alone can race that hydration and ask the
  // host for work items while its settings still read as unconfigured.
  const adoOrgName = config.ado?.orgName;
  const adoProjectName = config.ado?.projectName;
  const isAdoConnected = !!(config.ado?.isAuthenticated && adoOrgName && adoProjectName);

  // Populated by the WORKSPACE_PATH reply; null until it arrives, so the picker
  // doesn't flash "no folder open" during the first render.
  const [hasWorkspaceFolder, setHasWorkspaceFolder] = useState<boolean | null>(null);

  /**
   * Context picker rows, with unavailable sources shown but not selectable and
   * labelled with what to do about it. Picking one used to be a dead choice:
   * the host skips an override it can't satisfy and quietly routes somewhere
   * else, so "Azure DevOps" on a disconnected setup silently answered from the
   * codebase. The host still says so per-turn when a stored selection goes
   * stale; this stops new ones being made. Live sync/index percent comes from
   * the same store Settings uses, so the menu updates while a run is in flight.
   */
  const contextOptions: DropdownOption[] = [
    { value: 'Auto', label: 'Context: Auto' },
    knowledgeContextOption('Confluence', 'Confluence', {
      isAuthenticated: config.confluence?.isAuthenticated,
      isSyncing: config.confluence?.isSyncing,
      isIndexing: config.confluence?.isIndexing,
      isIndexingCompleted: config.confluence?.isIndexingCompleted,
      canResume: config.confluence?.canResume,
      canResumeIndexing: config.confluence?.canResumeIndexing,
      syncProgress: config.confluence?.confluenceSyncProgress ?? 0,
      indexProgress: config.confluence?.confluenceIndexProgress ?? 0,
    }),
    knowledgeContextOption('Azure DevOps', 'Azure DevOps', {
      isAuthenticated: config.ado?.isAuthenticated,
      isSyncing: config.ado?.isSyncing,
      isIndexing: config.ado?.isIndexing,
      isIndexingCompleted: config.ado?.isIndexingCompleted,
      canResume: config.ado?.canResume,
      canResumeIndexing: config.ado?.canResumeIndexing,
      syncProgress: config.ado?.adoSyncProgress ?? 0,
      indexProgress: config.ado?.adoIndexProgress ?? 0,
    }),
    {
      value: 'Codebase',
      label: 'Codebase',
      // The picker narrows what is SEARCHED, never what the assistant can do:
      // with a folder open the tools are on in every mode, and "Codebase"
      // only means "don't pre-fetch Confluence/ADO for this turn". Say so —
      // before 2026-09-05 the picker really did switch abilities on and off.
      ...(hasWorkspaceFolder === false
        ? { disabled: true, subtitle: 'No folder open in this window' }
        : { subtitle: 'Workspace only — skips the Confluence/ADO search' }),
    },
  ];

  // "Your work" panel state. `myWorkLoaded` distinguishes "no response yet"
  // from "responded with an empty list" — the panel must not say "nothing
  // assigned to you" while the first fetch is still in flight.
  const [myWorkItems, setMyWorkItems] = useState<WorkItemSummary[]>([]);
  const [myWorkSprint, setMyWorkSprint] = useState<string | undefined>(undefined);
  const [myWorkError, setMyWorkError] = useState<string | undefined>(undefined);
  const [myWorkLoaded, setMyWorkLoaded] = useState(false);
  const [myWorkRefreshing, setMyWorkRefreshing] = useState(false);
  /** Bounded auto-retries, so a lost hydration race self-heals. */
  const myWorkRetriesRef = useRef(0);
  // Remote mode is gated on GitHub sign-in (RemoteAuthMessageHandler /
  // RemoteAccountSettings.tsx), not a client-side API key — inference and
  // embeddings for remote mode run on the WorkspaceGPT server.
  const [remoteSignedIn, setRemoteSignedIn] = useState(false);
  // Weekly remote-mode quota, so the composer can warn before the user hits
  // a wall mid-chat instead of only surfacing this in Settings > Account.
  const [remoteUsage, setRemoteUsage] = useState<{
    used: number;
    limit: number;
    windowUsed?: number;
    windowLimit?: number;
    windowSeconds?: number;
  } | null>(null);

  // One poll loop behind both the status bar and the composer's Create PR button.
  useGitStatusSync(!!hasWorkspaceFolder);

  const modelProviders = useModelProviders();

  const selectedModelProvider = useSelectedModelProvider();

  const { handleModelChange } = useModelActions();

  const [activeModels, setActiveModels] = useState<
    {
      provider: string;
      model?: string;
    }[]
  >([]);

  // Sessions with a run still going while off-screen — history rows and
  // recent-chat cards show a live dot for these.
  const runningSessionIds = new Set(
    Object.entries(liveSessions)
      .filter(([, entry]) => entry.isLoading || entry.isStreaming)
      .map(([id]) => id)
  );

  // Same running signal, but including the visible session (whose turn state
  // lives at the top level of the store, not in liveSessions) — fed to the
  // native Sessions sidebar below so it can color-code each row's status dot
  // for sessions running in parallel.
  const allRunningSessionIds = new Set(runningSessionIds);
  if (currentSessionId && (isLoading || isStreaming)) {
    allRunningSessionIds.add(currentSessionId);
  }
  // Backgrounded sessions whose turn just finished while off-screen — kept
  // marked as "done, not yet seen" / "failed, not yet seen" until the user
  // actually opens them: activateLiveSession() (see handleSelectSession)
  // consumes the liveSessions entry on open, which drops it out of both sets
  // on its own. The visible session is excluded on purpose — it's on screen,
  // so it's already "read" the moment its turn finishes.
  const erroredSessionIds = new Set<string>();
  const completedSessionIds = new Set<string>();
  for (const [id, entry] of Object.entries(liveSessions)) {
    if (entry.isLoading || entry.isStreaming) continue;
    const lastMessage = entry.messages[entry.messages.length - 1];
    if (lastMessage?.isError) {
      erroredSessionIds.add(id);
    } else if (lastMessage && !lastMessage.isUser) {
      completedSessionIds.add(id);
    }
  }
  const runningIdsKey = [...allRunningSessionIds].sort().join(',');
  const erroredIdsKey = [...erroredSessionIds].sort().join(',');
  const completedIdsKey = [...completedSessionIds].sort().join(',');

  // Sha currently being reverted to — disables the triggering message's undo
  // button until the host confirms (AGENT_REVERT_DONE).
  const [revertingSha, setRevertingSha] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // ── Stick-to-bottom ──────────────────────────────────────────────────────
  // Auto-scroll only while the user is reading the tail of the chat; once they
  // scroll up (e.g. to review a diff card) the view must stay put. Position
  // alone can't decide that: streamed text and new timeline steps grow the
  // scroll height constantly, so "far from the bottom" happens with no user
  // input at all. `pinnedRef` is therefore a latch — it only unpins on an
  // actual upward scroll, and re-pins whenever the view is back at the bottom.
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  // State copy of the same node, so the observer effect below re-runs when the
  // container mounts/unmounts (chat ⇄ home ⇄ history) without re-running on
  // every streamed chunk.
  const [messagesEl, setMessagesEl] = useState<HTMLDivElement | null>(null);
  // Stable identity: an inline arrow ref would detach/reattach every render.
  const setMessagesRef = useCallback((el: HTMLDivElement | null) => {
    messagesContainerRef.current = el;
    setMessagesEl(el);
  }, []);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // True when a write review is pending but its Approve/Reject row is out of
  // view — the pinned action bar above the composer takes over then.
  const [reviewActionsOffscreen, setReviewActionsOffscreen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Files staged in the composer, sent with the next message.
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  // Transient note when a picked/pasted file was rejected (type/size/count).
  const [attachmentNote, setAttachmentNote] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ── @-mention picker ──
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionTargets, setMentionTargets] = useState<MentionTarget[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionSearching, setMentionSearching] = useState(false);
  // Character offset of the "@" the picker is completing.
  const mentionStartRef = useRef(0);
  // Paths inserted from the picker this message — the only ones sent to the
  // host for resolution (see activeMentions).
  const pickedMentionsRef = useRef<Set<string>>(new Set());
  // Latest in-flight search; older responses are ignored so a slow reply for
  // an earlier keystroke can't replace newer suggestions.
  const mentionRequestIdRef = useRef(0);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sessions the user explicitly stopped: anything their runs still emit is
  // discarded. useRef (not state) so it's always current inside the stale
  // useEffect message-handler closure; sending in a session clears its entry.
  const stoppedSessionsRef = useRef<Set<string>>(new Set());
  // Mirror of currentSessionId for the same stale-closure reason — the message
  // handler routes each host message to the visible chat or a background one.
  const currentSessionIdRef = useRef<string | null>(null);
  // Fresh handleNewChat for the host-initiated NEW_CHAT command (stale closure).
  const handleNewChatRef = useRef<() => void>(() => {});
  const handleSelectSessionRef = useRef<(sessionId: string) => void>(() => {});

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

  // Stop the typewriter and dump whatever is still buffered into the last
  // message. Used when the host says the stream is finished — typing the
  // report out after the run is over is the "answer appears slowly" bug:
  // agent reports often arrive as one large chunk right as the worker
  // sends `done`, and each pump tick re-parses the growing markdown.
  const flushStreamRemainder = useCallback(() => {
    if (pumpRef.current !== null) {
      clearInterval(pumpRef.current);
      pumpRef.current = null;
    }
    const pending = pendingTextRef.current;
    if (pending.length > 0) {
      pendingTextRef.current = '';
      appendToLastMessage(pending);
    }
    if (streamDoneRef.current) {
      streamDoneRef.current = false;
      setIsStreaming(false);
    }
  }, [appendToLastMessage, setIsStreaming]);

  // Drains pendingTextRef into the last message a few chars per tick so the
  // response "types out" smoothly while tokens are still arriving. Pauses
  // itself when the buffer empties; once the stream is marked done, dumps
  // the rest in one shot instead of animating it.
  const startStreamPump = useCallback(() => {
    if (pumpRef.current !== null) return; // already running
    pumpRef.current = setInterval(() => {
      if (streamDoneRef.current) {
        flushStreamRemainder();
        return;
      }
      const pending = pendingTextRef.current;
      if (pending.length === 0) {
        if (pumpRef.current !== null) {
          clearInterval(pumpRef.current);
          pumpRef.current = null;
        }
        return;
      }
      // Keep a typewriter while tokens are in flight, but drain a large
      // backlog quickly (NVIDIA/Gemini sometimes dump hundreds of chars per
      // SSE event) so markdown isn't re-parsed 2 chars at a time for seconds.
      const count = Math.max(8, Math.ceil(pending.length / 8));
      pendingTextRef.current = pending.slice(count);
      appendToLastMessage(pending.slice(0, count));
    }, 16);
  }, [appendToLastMessage, flushStreamRemainder]);

  // The message handler lives in a mount-once effect (stale-closure by design
  // — same as handleNewChatRef). Keep the latest pump helpers here so DONE
  // always flushes with the current appendToLastMessage.
  const startStreamPumpRef = useRef(startStreamPump);
  const flushStreamRemainderRef = useRef(flushStreamRemainder);
  startStreamPumpRef.current = startStreamPump;
  flushStreamRemainderRef.current = flushStreamRemainder;

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
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_WORKSPACE_PATH,
    });

    // Request history list on mount
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_CHAT_HISTORY_LIST,
    });

    // So the composer already knows whether remote mode can be used, without
    // waiting for the user to open Settings first.
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_REMOTE_SESSION,
    });

    // Applies a turn-scoped host message to a session that is NOT on screen.
    // Goes through getState() so it never suffers from this closure's staleness.
    const applyBackgroundTurnMessage = (sessionId: string, message: any) => {
      const store = useChatStore.getState();
      // Untracked session (e.g. the webview reloaded mid-run): nothing safe to
      // apply the update to — dropping it beats corrupting another session.
      if (!store.liveSessions[sessionId]) return;
      const saveBg = () => {
        const entry = useChatStore.getState().liveSessions[sessionId];
        if (entry && entry.messages.length > 0) {
          vscode.postMessage({
            type: MESSAGE_TYPES.SAVE_CHAT_HISTORY,
            sessionId,
            messages: entry.messages,
          });
        }
      };
      switch (message.type) {
        case MESSAGE_TYPES.RECEIVE_MESSAGE:
          store.bgAddMessage(sessionId, { content: message.content, isUser: false });
          store.bgPatch(sessionId, { isLoading: false, isStreaming: false, statusText: '' });
          saveBg();
          break;
        case MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK:
          // No typewriter for an off-screen chat — append the text directly.
          store.bgAppendToLast(sessionId, message.content || '');
          store.bgPatch(sessionId, { isLoading: false, isStreaming: true, statusText: '' });
          break;
        case MESSAGE_TYPES.RECEIVE_MESSAGE_DONE:
          store.bgFinalizeTurn(sessionId, message.fallbackAnswer || AGENT_FALLBACK_ANSWER);
          store.bgPatch(sessionId, { isLoading: false, isStreaming: false, statusText: '' });
          saveBg();
          break;
        case MESSAGE_TYPES.RETRIEVAL_STATUS:
          store.bgPatch(sessionId, { statusText: message.text || '' });
          break;
        case MESSAGE_TYPES.AGENT_STEP:
          if (message.step) {
            store.bgAddAgentStep(sessionId, { ...message.step, ...(message.id ? { id: message.id } : {}) });
          } else if (message.text) {
            store.bgAddAgentStep(sessionId, { kind: 'info', title: message.text });
          }
          break;
        case MESSAGE_TYPES.AGENT_STEP_UPDATE:
          if (message.id) {
            store.bgUpdateAgentStep(sessionId, message.id, {
              status: message.status || 'done',
              summary: message.summary,
              meta: message.meta,
            });
          }
          break;
        case MESSAGE_TYPES.AGENT_TURN_SUMMARY:
          store.bgSetTurnSummary(sessionId, {
            durationMs: message.durationMs || 0,
            filesChanged: message.filesChanged || [],
            checkpointSha: message.checkpointSha,
            ticketId: message.ticketId,
            shippable: !!message.shippable,
          });
          break;
        case MESSAGE_TYPES.AGENT_WRITE_REVIEW:
          store.bgAddMessage(sessionId, {
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
          store.bgPatch(sessionId, { statusText: 'Waiting for your review…' });
          break;
        case MESSAGE_TYPES.AGENT_WRITE_REVIEWS_CLOSED:
          store.bgCloseAllPendingWriteReviews(sessionId);
          store.bgPatch(sessionId, { statusText: '' });
          break;
        case MESSAGE_TYPES.ERROR_CHAT:
          store.bgAddMessage(sessionId, {
            content: formatChatError(message.message || 'An unknown error occurred.'),
            isUser: false,
            isError: true,
            ...(message.resumable ? { resumable: message.resumable } : {}),
          });
          store.bgPatch(sessionId, { isLoading: false, isStreaming: false, statusText: '' });
          saveBg();
          break;
      }
    };

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      // A shipped turn is recorded on its message (and so persisted) here,
      // independent of whichever FilesChangedBar is currently mounted.
      if (message.type === MESSAGE_TYPES.AGENT_SHIP_DONE && message.ok && message.branch) {
        useChatStore.getState().markTurnShipped(message.sessionId ?? currentSessionIdRef.current, {
          branch: message.branch,
          prUrl: message.prUrl,
          ticketCommented: !!message.ticketCommented,
        });
      }

      // Route turn-scoped messages by the session they belong to. Messages
      // from an old host build carry no sessionId — treat them as belonging
      // to the visible chat, matching the previous behavior.
      if (TURN_SCOPED_TYPES.has(message.type)) {
        const sid: string | null = message.sessionId ?? currentSessionIdRef.current;
        if (sid && stoppedSessionsRef.current.has(sid)) return;
        if (sid && sid !== currentSessionIdRef.current) {
          applyBackgroundTurnMessage(sid, message);
          return;
        }
      }

      switch (message.type) {
        case MESSAGE_TYPES.RECEIVE_MESSAGE:
          addMessage({
            content: message.content,
            isUser: false,
          });
          setStatusText('');
          setIsLoading(false);
          setIsStreaming(false);
          break;
        case MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK:
          // Buffer the chunk; the pump drains it to the UI at a steady rate.
          pendingTextRef.current += message.content || '';
          setStatusText('');
          setIsLoading(false); // Stop loading animation since we're streaming now
          setIsStreaming(true);
          startStreamPumpRef.current();
          break;
        case MESSAGE_TYPES.RECEIVE_MESSAGE_DONE: {
          setStatusText('');
          setIsLoading(false);
          streamDoneRef.current = true;
          // Dump buffered text immediately — don't keep the typewriter
          // running after the model has finished.
          if (pendingTextRef.current.length > 0) {
            flushStreamRemainderRef.current();
          } else {
            if (pumpRef.current !== null) {
              clearInterval(pumpRef.current);
              pumpRef.current = null;
            }
            streamDoneRef.current = false;
            setIsStreaming(false);
            // The model finished without any text: the steps and files-changed
            // rollup accumulated this turn must never vanish — materialize an
            // answer to carry them, worded by the HOST (which knows how many
            // writes actually landed) rather than by a constant here.
            //
            // A turn that did nothing at all sends no fallbackAnswer: the host
            // reports that as an ERROR_CHAT card instead, which has already
            // added a message by now, so the guard below skips it.
            const { messages: currentMsgs } = useChatStore.getState();
            const last = currentMsgs[currentMsgs.length - 1];
            if (!last || last.isUser || last.writeReview) {
              finalizeAgentTurn(message.fallbackAnswer || AGENT_FALLBACK_ANSWER);
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
            checkpointSha: message.checkpointSha,
            ticketId: message.ticketId,
            shippable: !!message.shippable,
          });
          break;
        case MESSAGE_TYPES.AGENT_REVERT_DONE:
          setRevertingSha(null);
          if (message.ok) {
            setStatusText('Undone.');
            setTimeout(() => setStatusText(''), 2000);
          }
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
          resetStreamBuffer();
          addMessage({
            content: formatChatError(message.message || 'An unknown error occurred.'),
            isUser: false,
            isError: true,
            // Present when the host is still holding the interrupted run —
            // drives the Resume button on the card (see ChatMessage).
            ...(message.resumable ? { resumable: message.resumable } : {}),
          });
          setStatusText('');
          setIsLoading(false);
          setIsStreaming(false);
          break;
        }
        case MESSAGE_TYPES.SHOW_SETTINGS:
          setActiveView('settings');
          break;
        case MESSAGE_TYPES.WORKSPACE_PATH:
          // Answer to the GET_WORKSPACE_PATH sent on mount. Empty path means no
          // folder is open, which is exactly what makes codebase tools
          // unavailable host-side — `config.codebase.repoPath` can't stand in
          // for this, since the host persists it and it survives into windows
          // that have no folder open at all.
          setHasWorkspaceFolder(!!message.path);
          break;
        case MESSAGE_TYPES.REMOTE_SESSION_STATUS:
        case MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS:
          setRemoteSignedIn(
            message.type === MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS ? true : !!message.signedIn
          );
          {
            // Credits (token-metered) with the request-era names as fallback
            // for a host that predates them.
            const limit = message.creditsLimitWeekly ?? message.requestsLimitWeekly;
            setRemoteUsage(
              typeof limit === 'number'
                ? {
                    used: message.creditsUsedThisWeek ?? message.requestsUsedThisWeek ?? 0,
                    limit,
                    windowUsed: message.creditsUsedWindow,
                    windowLimit: message.creditsLimitWindow,
                    windowSeconds: message.windowSeconds,
                  }
                : null
            );
          }
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS:
          setRemoteSignedIn(false);
          setRemoteUsage(null);
          break;
        case MESSAGE_TYPES.NEW_CHAT:
          handleNewChatRef.current();
          break;
        case MESSAGE_TYPES.LOAD_CHAT_SESSION:
          if (message.sessionId) handleSelectSessionRef.current(message.sessionId);
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
        case MESSAGE_TYPES.CHAT_SNAPSHOT_REQUEST:
          flushStreamRemainderRef.current();
          vscode.postMessage({
            type: MESSAGE_TYPES.CHAT_SNAPSHOT,
            snapshot: {
              ...collectChatSnapshot(),
              pendingStreamText: pendingTextRef.current,
              activeView: useUiStore.getState().activeView,
            },
          });
          break;
        case MESSAGE_TYPES.CHAT_SNAPSHOT_APPLY: {
          const snap = message.snapshot || {};
          applyChatSnapshot(snap);
          if (typeof snap.pendingStreamText === 'string') {
            pendingTextRef.current = snap.pendingStreamText;
          }
          if (snap.activeView) {
            setActiveView(snap.activeView);
          }
          currentSessionIdRef.current = snap.currentSessionId ?? null;
          break;
        }
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
        case MESSAGE_TYPES.GET_MY_WORK_ITEMS_RESPONSE: {
          // Two responses arrive per request when a cache exists (cache, then
          // fresh); each simply replaces the list. Only the fresh one ends the
          // refreshing state.
          const items = message.items || [];
          setMyWorkItems(items);
          setMyWorkSprint(message.currentSprintName);
          setMyWorkLoaded(true);

          // A failure with nothing to show may just be a lost race against the
          // host's settings hydration — retry a couple of times before
          // reporting it, rather than leaving a permanent "not configured" on
          // screen for an account that IS configured.
          if (message.error && !items.length && myWorkRetriesRef.current < 2) {
            myWorkRetriesRef.current += 1;
            setTimeout(
              () => vscode.postMessage({ type: MESSAGE_TYPES.GET_MY_WORK_ITEMS, forceRefresh: true }),
              1200
            );
            break;
          }

          setMyWorkError(message.error);
          if (!message.fromCache || message.error) setMyWorkRefreshing(false);
          break;
        }
        case MESSAGE_TYPES.SEARCH_MENTION_TARGETS_RESPONSE:
          // Drop stale replies — only the newest keystroke's results count.
          if (message.requestId === mentionRequestIdRef.current) {
            setMentionTargets(message.targets ?? []);
            setMentionIndex(0);
            setMentionSearching(false);
          }
          break;
        case MESSAGE_TYPES.GET_CHAT_SESSION_RESPONSE:
          if (message.messages) {
            setMessages(message.messages);
            setCurrentSessionId(message.sessionId);
            currentSessionIdRef.current = message.sessionId;
            // A stored session opens idle — clear turn state left behind by
            // whatever chat was on screen before.
            resetTurnState();
            setIsLoading(false);
            setIsStreaming(false);
            setStatusText('');
            setShowTips(false);
            setActiveView('chat');
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({
      type: MESSAGE_TYPES.CHAT_WEBVIEW_READY,
      layout: initialChatLayout(),
    });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.SESSION_CHANGED,
      sessionId: currentSessionId,
    });
  }, [currentSessionId]);

  // Report which sessions are running/completed/errored whenever one of
  // those sets actually changes (keyed on the sorted id lists, not the Sets
  // themselves, since those are rebuilt fresh every render) — the Sessions
  // sidebar webview uses this to color its per-row status dot.
  useEffect(() => {
    vscode.postMessage({
      type: MESSAGE_TYPES.SESSIONS_RUNNING_STATE,
      runningSessionIds: runningIdsKey ? runningIdsKey.split(',') : [],
      completedSessionIds: completedIdsKey ? completedIdsKey.split(',') : [],
      erroredSessionIds: erroredIdsKey ? erroredIdsKey.split(',') : [],
    });
  }, [runningIdsKey, completedIdsKey, erroredIdsKey]);

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

  // The write review the current turn is blocked on, if any. Only counted while
  // a turn is actually in flight: an undecided card rehydrated from history is
  // a dead gate (the host's promise is long gone) and must not hijack the
  // viewport or offer buttons that do nothing.
  const pendingReview = useMemo(() => {
    if (!isLoading && !isStreaming) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const review = messages[i].writeReview;
      if (review && !review.decision) return review;
    }
    return null;
  }, [messages, isLoading, isStreaming]);
  const pendingReviewIdRef = useRef<string | null>(null);
  pendingReviewIdRef.current = pendingReview?.id ?? null;

  /** Distance from the bottom (px) still counted as "reading the tail". */
  const NEAR_BOTTOM_PX = 48;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Instant by default: a smooth animation restarted on every streamed chunk
    // never catches up, and its intermediate positions look like the user
    // scrolling away.
    el.scrollTo({ top: el.scrollHeight, behavior });
    lastScrollTopRef.current = el.scrollHeight - el.clientHeight;
  }, []);

  const pinToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      pinnedRef.current = true;
      setShowJumpToBottom(false);
      scrollToBottom(behavior);
    },
    [scrollToBottom]
  );

  /** Is the pending review's Approve/Reject row currently reachable on screen? */
  const syncReviewActionsVisibility = useCallback(() => {
    const el = messagesContainerRef.current;
    const id = pendingReviewIdRef.current;
    if (!el || !id) {
      setReviewActionsOffscreen(false);
      return;
    }
    // Re-queried every time rather than cached: the row is a different DOM node
    // once the card switches into "Reject…" mode.
    const actions = el.querySelector<HTMLElement>(`[data-review-actions="${id}"]`);
    if (!actions) {
      // Card exists in state but isn't rendered (collapsed history fork) —
      // treat as unreachable so the pinned bar still offers the decision.
      setReviewActionsOffscreen(true);
      return;
    }
    const rowRect = actions.getBoundingClientRect();
    const viewRect = el.getBoundingClientRect();
    setReviewActionsOffscreen(rowRect.bottom > viewRect.bottom + 4 || rowRect.top < viewRect.top - 4);
  }, []);

  const handleMessagesScroll = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = el.scrollTop < lastScrollTopRef.current - 2;
    lastScrollTopRef.current = el.scrollTop;
    // Being at the bottom wins over direction: collapsing a card shrinks the
    // content and drags scrollTop down with it, which isn't the user leaving.
    pinnedRef.current =
      distance <= NEAR_BOTTOM_PX ? true : scrolledUp ? false : pinnedRef.current;
    setShowJumpToBottom(!pinnedRef.current);
    syncReviewActionsVisibility();
  };

  // Scroll events can lag a frame behind the wheel, which during a fast stream
  // is long enough for the auto-scroll to yank the view back. Treat the wheel
  // itself as the intent signal.
  const handleMessagesWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const el = messagesContainerRef.current;
    if (!el || e.deltaY >= 0 || el.scrollTop <= 0) return;
    pinnedRef.current = false;
    setShowJumpToBottom(true);
  };

  useEffect(() => {
    if (!messagesEl) return;
    // Anything that changes the content height has to re-glue the view:
    // streamed text, a new timeline step, syntax highlighting settling, an
    // image finishing load. A [messages] effect sees none of those.
    const onContentChange = () => {
      if (pinnedRef.current) scrollToBottom('auto');
      syncReviewActionsVisibility();
    };
    // Coalesced to one measurement per frame: the typewriter pump commits many
    // times a second and each pass forces layout.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        onContentChange();
      });
    };
    const mutation = new MutationObserver(schedule);
    mutation.observe(messagesEl, { childList: true, subtree: true, characterData: true });
    // Container shrink (composer grew, panel resized) counts too.
    const resize = new ResizeObserver(schedule);
    resize.observe(messagesEl);
    onContentChange();
    return () => {
      mutation.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [messagesEl, scrollToBottom, syncReviewActionsVisibility]);

  // Opening another chat starts at its newest message.
  useEffect(() => {
    pinToBottom('auto');
  }, [currentSessionId, pinToBottom]);

  const scrollToReview = useCallback((id: string) => {
    const el = messagesContainerRef.current;
    const card = el?.querySelector<HTMLElement>(`[data-review-id="${id}"]`);
    // Jumping up unpins via the scroll handler, so the run can't drag the
    // viewport off the diff the user is reading.
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  // A newly opened review is what the turn is waiting on — bring it into view
  // once, the way Cursor jumps to a pending diff, instead of leaving it
  // stranded above whatever the live timeline is printing.
  const jumpedReviewIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingReview) {
      jumpedReviewIdRef.current = null;
      return;
    }
    if (jumpedReviewIdRef.current === pendingReview.id) return;
    jumpedReviewIdRef.current = pendingReview.id;
    const id = pendingReview.id;
    requestAnimationFrame(() => scrollToReview(id));
  }, [pendingReview, scrollToReview]);

  /** Shared tail of both decision paths (card buttons and pinned bar). */
  const handleReviewDecided = (id: string, decision: 'approved' | 'rejected') => {
    setWriteReviewDecision(id, decision);
    // The run resumes host-side; stop claiming we're waiting.
    setStatusText('');
    // Deciding means following the run again.
    pinToBottom('auto');
  };

  /** Approve/reject from the pinned bar; the card posts its own decision. */
  const decideReview = (id: string, approved: boolean) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.AGENT_WRITE_DECISION,
      id,
      approved,
      scope: 'once',
    });
    handleReviewDecided(id, approved ? 'approved' : 'rejected');
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

  // Moves the visible session's in-flight turn to the background so it keeps
  // running while the user looks at another chat: drain the typewriter buffer
  // into the transcript (background chats don't animate), then park the live
  // state under the session's id. Host messages for it are routed there by
  // the handler above. No-op when nothing is running.
  const backgroundCurrentSession = () => {
    // Synchronously flush what the pump hasn't typed out yet — the stash must
    // capture the full transcript, not the animation's progress.
    flushStreamRemainder();
    stashCurrentSession();
    // Reset the visible turn state for whatever session comes next; if a run
    // was stashed, its copy of this state lives in liveSessions now.
    resetTurnState();
    setIsLoading(false);
    setIsStreaming(false);
    setStatusText('');
  };

  // skipSave: the current session's history was just deleted (e.g. from the
  // history sidebar) — saving it here would just recreate the file we removed.
  const handleNewChat = (skipSave = false) => {
    backgroundCurrentSession();

    // Save current chat before starting a new one
    if (!skipSave && currentSessionId && messages.length > 0) {
      // Force an immediate save (no debounce)
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_CHAT_HISTORY,
        sessionId: currentSessionId,
        messages,
      });
    }
    clearMessages();
    setInputValue('');
    setCurrentSessionId(null);
    // Synchronously: the stashed session's messages must route to the
    // background from this instant, not after the next render.
    currentSessionIdRef.current = null;
    setShowTips(true);
    setActiveView('chat');
  };
  // The message handler's closure is created once ([] deps) — give it a
  // always-fresh path to handleNewChat for the host-initiated NEW_CHAT command.
  handleNewChatRef.current = handleNewChat;

  const handleSendMessage = () => {
    if ((inputValue.trim() === '' && pendingAttachments.length === 0) || isLoading) return;

    // Local mode: a model must be selected. Remote mode has no model picker —
    // it just needs a Gemini key (the host routes the actual model by task).
    if (mode === 'local' && !selectedModelProvider?.selectedModel) {
      vscode.postMessage({
        type: MESSAGE_TYPES.ONBOARDING_EVENT,
        event: 'message_blocked_no_model',
        properties: { mode, reason: 'no_model_selected' },
      });
      addMessage({
        content: 'Please select the model from settings to use the model',
        isUser: false,
      });
      return;
    }
    if (mode === 'remote' && !remoteSignedIn) {
      vscode.postMessage({
        type: MESSAGE_TYPES.ONBOARDING_EVENT,
        event: 'message_blocked_no_model',
        properties: { mode, reason: 'not_signed_in' },
      });
      addMessage({
        content: 'Sign up with WorkspaceGPT in Settings to start chatting.',
        isUser: false,
      });
      return;
    }

    // Only now that the request is definitely going out: drop any leftover
    // typewriter buffer from this session's prior stream.
    resetStreamBuffer();

    // If no session ID yet, generate one now
    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = generateSessionId();
      setCurrentSessionId(sessionId);
      currentSessionIdRef.current = sessionId;
    }
    // A new request in a previously stopped session accepts messages again.
    stoppedSessionsRef.current.delete(sessionId);

    const mentions = activeMentions(inputValue, pickedMentionsRef.current);

    addMessage({
      content: inputValue,
      isUser: true,
      ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    });

    setInputValue('');
    setPendingAttachments([]);
    setAttachmentNote(null);
    pickedMentionsRef.current = new Set();
    closeMentionPicker();
    // Sending always follows the new turn, wherever the user was scrolled.
    pinToBottom('auto');
    setIsLoading(true);
    setIsStreaming(false);
    setShowTips(false);

    // Get the selected model directly from the dropdown

    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      sessionId,
      message: inputValue,
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider, // Use the provider string from the selectedModelProvider object
      apiKey: selectedModelProvider?.apiKey,
      contextSelection: contextSelection,
      ...modeFlags(),
      ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    });
  };

  // ── Composer attachments ──────────────────────────────────────────────
  const stageFiles = async (files: File[]) => {
    if (!files.length) return;
    const { attachments, skippedNote } = await filesToAttachments(files, pendingAttachments.length);
    if (attachments.length) setPendingAttachments((prev) => [...prev, ...attachments]);
    setAttachmentNote(skippedNote);
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    stageFiles(Array.from(e.target.files ?? []));
    // Reset so picking the same file again re-fires onChange.
    e.target.value = '';
  };

  const handleComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      stageFiles(files);
    }
  };

  const handleComposerDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    stageFiles(Array.from(e.dataTransfer?.files ?? []));
  };

  const removeAttachment = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
    setAttachmentNote(null);
  };

  // ── @-mentions ────────────────────────────────────────────────────────
  const closeMentionPicker = () => {
    if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    setMentionQuery(null);
    setMentionTargets([]);
    setMentionIndex(0);
    setMentionSearching(false);
  };

  /**
   * Re-evaluates the picker against the caret position. Called after every
   * edit and caret move, so the picker opens on "@", follows what is typed
   * after it, and closes as soon as the caret leaves the token.
   */
  const syncMentionPicker = (text: string, caret: number) => {
    const token = findMentionToken(text, caret);
    if (!token) {
      if (mentionQuery !== null) closeMentionPicker();
      return;
    }
    mentionStartRef.current = token.start;
    setMentionQuery(token.query);
    setMentionSearching(true);
    if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    mentionDebounceRef.current = setTimeout(() => {
      const requestId = mentionRequestIdRef.current + 1;
      mentionRequestIdRef.current = requestId;
      vscode.postMessage({
        type: MESSAGE_TYPES.SEARCH_MENTION_TARGETS,
        requestId,
        query: token.query,
      });
    }, 120);
  };

  const handleComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value);
    syncMentionPicker(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  /** Replaces the in-progress "@token" with the chosen path and resumes typing after it. */
  const insertMention = (target: MentionTarget) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? inputValue.length;
    const start = mentionStartRef.current;
    const rest = inputValue.slice(caret);
    // Separate the mention from whatever follows, without doubling a space
    // that is already there.
    const inserted = `@${target.path}${/^\s/.test(rest) ? '' : ' '}`;
    const next = inputValue.slice(0, start) + inserted + rest;
    pickedMentionsRef.current.add(target.path);
    setInputValue(next);
    closeMentionPicker();
    // Put the caret after the inserted mention once React has re-rendered
    // with the new value, otherwise it snaps to the end of the textarea.
    requestAnimationFrame(() => {
      const pos = start + inserted.length;
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
    });
  };

  const handleStopMessage = () => {
    if (!currentSessionId) return;
    // Discard anything this session's run still emits (retrieval statuses
    // keep arriving after the worker dies) until the user sends again.
    stoppedSessionsRef.current.add(currentSessionId);
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_MESSAGE,
      sessionId: currentSessionId,
    });
    resetStreamBuffer();
    setIsLoading(false);
    setIsStreaming(false);
    setStatusText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the mention picker is open it owns the navigation keys — Enter
    // must pick a file rather than send the half-typed message.
    if (mentionQuery !== null && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (mentionTargets.length) {
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          setMentionIndex((i) => (i + delta + mentionTargets.length) % mentionTargets.length);
        }
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const target = mentionTargets[mentionIndex];
        if (target) {
          e.preventDefault();
          insertMention(target);
          return;
        }
        // Nothing to pick (still searching / no matches): fall through so
        // Enter still sends rather than dead-ending on an empty picker.
        closeMentionPicker();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionPicker();
        return;
      }
    }

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

  /**
   * Re-autosize when the composer's own width changes.
   *
   * Value-change alone is not enough: dragging the sidebar narrower rewraps the
   * existing text onto more lines while the inline height stays at the old
   * measurement, and the overflow rule then chops the tail off mid-line with no
   * scrollbar to reach it. Only width is watched — reacting to height would
   * feed autosize's own height writes straight back in as a loop.
   */
  useEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      autosizeInput(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * Load "your work" whenever ADO is connected (and clear it when it isn't, so
   * disconnecting doesn't leave a stale list on screen). Fires once per connect
   * rather than on every empty state, since the host answers from cache first.
   */
  useEffect(() => {
    if (!isAdoConnected) {
      setMyWorkItems([]);
      setMyWorkLoaded(false);
      setMyWorkError(undefined);
      return;
    }
    myWorkRetriesRef.current = 0;
    setMyWorkRefreshing(true);
    vscode.postMessage({ type: MESSAGE_TYPES.GET_MY_WORK_ITEMS });
    // Re-runs if org/project arrive or change (project switch, late hydration).
  }, [isAdoConnected, adoOrgName, adoProjectName]);

  const handleRefreshMyWork = () => {
    myWorkRetriesRef.current = 0;
    setMyWorkRefreshing(true);
    setMyWorkError(undefined);
    vscode.postMessage({ type: MESSAGE_TYPES.GET_MY_WORK_ITEMS, forceRefresh: true });
  };

  /**
   * Seed the composer from a ticket — deliberately WITHOUT sending. A ticket is
   * a big, under-specified task; the user should see and be able to adjust the
   * ask before the agent starts.
   *
   * The prompt asks for the org-context step (read the ticket, read the design
   * doc behind it) explicitly, but does NOT forbid changes. An earlier version
   * ended with "propose a plan before changing anything", which cost a whole
   * turn and then stranded the work: the agent re-derived the same
   * investigation and re-proposed it on every follow-up. Approval is already
   * enforced per write — each edit is shown as a diff to accept or reject —
   * so a turn-level plan gate duplicates that protection at much worse
   * granularity. Ambiguity is still called out below, which is the case a plan
   * was actually wanted for.
   */
  const handleSelectWorkItem = (item: WorkItemSummary) => {
    setInputValue(
      `Work on ticket ${item.id} (${item.title}) — read the ticket and any design doc behind it, ` +
        'find the code it affects, then implement the fix. Show me the diffs as you go. ' +
        'If, after reading the ticket, the docs, and the code, a decision the ticket should have made ' +
        "is genuinely missing, say exactly what's unclear instead of guessing."
    );
    inputRef.current?.focus();
  };

  /**
   * Click-to-run: the ▶ on a work item starts an autonomous run immediately —
   * no composer stop, no per-change approvals (the host auto-applies writes,
   * checkpointed and reviewable afterwards). The prompt therefore asks for the
   * full loop including verification, and — since nobody is present to answer —
   * makes "stop and report the blocker" the expected ambiguity outcome.
   */
  const handleAutoRunWorkItem = (item: WorkItemSummary) => {
    if (mode === 'local' && !selectedModelProvider?.selectedModel) {
      addMessage({
        content: 'Please select the model from settings to use the model',
        isUser: false,
      });
      return;
    }
    if (mode === 'remote' && !remoteSignedIn) {
      addMessage({
        content: 'Sign up with WorkspaceGPT in Settings to start chatting.',
        isUser: false,
      });
      return;
    }
    const promptText =
      `Work on ticket ${item.id} (${item.title}) autonomously — read the ticket and any design doc behind it, ` +
      'find the code it affects, implement the fix, verify with diagnostics and the relevant tests, ' +
      'and report the result against each acceptance criterion. ' +
      'If, after reading the ticket, the docs, and the code, a decision the ticket should have made ' +
      "is genuinely missing, stop and report exactly what's unclear instead of guessing.";
    resetStreamBuffer();
    let sessionId = currentSessionId;
    if (!sessionId) {
      sessionId = generateSessionId();
      setCurrentSessionId(sessionId);
      currentSessionIdRef.current = sessionId;
    }
    stoppedSessionsRef.current.delete(sessionId);
    addMessage({ content: promptText, isUser: true });
    setInputValue('');
    setIsLoading(true);
    setIsStreaming(false);
    setShowTips(false);
    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      sessionId,
      message: promptText,
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider,
      apiKey: selectedModelProvider?.apiKey,
      contextSelection: contextSelection,
      autonomous: true,
    });
  };

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
      if (mode === 'remote' && !remoteSignedIn) {
        addMessage({
          content: 'Sign up with WorkspaceGPT in Settings to start chatting.',
          isUser: false,
        });
        return;
      }
      resetStreamBuffer(); // Discard any leftover buffer from a prior stream
      let sessionId = currentSessionId;
      if (!sessionId) {
        sessionId = generateSessionId();
        setCurrentSessionId(sessionId);
        currentSessionIdRef.current = sessionId;
      }
      stoppedSessionsRef.current.delete(sessionId);
      addMessage({ content: promptText, isUser: true });
      setInputValue('');
      setIsLoading(true);
      setIsStreaming(false);
      setShowTips(false);
      vscode.postMessage({
        type: MESSAGE_TYPES.SEND_MESSAGE,
        sessionId,
        message: promptText,
        modelId: selectedModelProvider?.selectedModel,
        provider: selectedModelProvider.provider,
        apiKey: selectedModelProvider?.apiKey,
        contextSelection: contextSelection,
        ...modeFlags(),
      });
    }, 0);
  };

  const handleSelectSession = (sessionId: string) => {
    if (sessionId === currentSessionId) {
      setActiveView('chat');
      return;
    }
    // A running turn keeps going — park it so its stream lands off-screen.
    backgroundCurrentSession();

    // Save current chat first
    if (currentSessionId && messages.length > 0) {
      vscode.postMessage({
        type: MESSAGE_TYPES.SAVE_CHAT_HISTORY,
        sessionId: currentSessionId,
        messages,
      });
    }
    // A backgrounded session resumes from its live state — fresher than disk,
    // and its run (if any) continues into the visible chat from here.
    if (activateLiveSession(sessionId)) {
      currentSessionIdRef.current = sessionId;
      setActiveView('chat');
      return;
    }
    // Otherwise request the stored session from the extension host. Route by
    // the target immediately so the stashed session's stream stays background
    // while the transcript loads.
    currentSessionIdRef.current = sessionId;
    vscode.postMessage({
      type: MESSAGE_TYPES.GET_CHAT_SESSION,
      sessionId,
    });
  };
  handleSelectSessionRef.current = handleSelectSession;

  const handleDeleteSession = (sessionId: string) => {
    // Kill any run this session still has going, then forget its live state.
    stoppedSessionsRef.current.add(sessionId);
    vscode.postMessage({ type: MESSAGE_TYPES.STOP_MESSAGE, sessionId });
    dropLiveSession(sessionId);
    vscode.postMessage({
      type: MESSAGE_TYPES.DELETE_CHAT_HISTORY,
      sessionId,
    });
    // If deleting the active session, reset — but skip the save-before-new-chat
    // step, since that would just resave the messages under the file we deleted.
    if (sessionId === currentSessionId) {
      handleNewChat(true);
    }
  };

  const handleUndo = (sha: string) => {
    setRevertingSha(sha);
    vscode.postMessage({ type: MESSAGE_TYPES.AGENT_REVERT_CHECKPOINT, sha });
  };

  const handleFeedback = (messageIndex: number, rating: 'up' | 'down') => {
    vscode.postMessage({ type: MESSAGE_TYPES.MESSAGE_FEEDBACK, rating, messageIndex });
  };

  // Resend a message that errored out — drops its error bubble and re-runs
  // the same request, without re-adding the user bubble (already on screen).
  const handleRetry = (
    content: string,
    errorIndex: number,
    attachments?: ChatAttachment[],
    mentions?: string[]
  ) => {
    if (isLoading) return;
    removeMessageAt(errorIndex);
    if (currentSessionId) stoppedSessionsRef.current.delete(currentSessionId);
    resetStreamBuffer();
    setIsLoading(true);
    setIsStreaming(false);
    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      sessionId: currentSessionId,
      message: content,
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider,
      apiKey: selectedModelProvider?.apiKey,
      contextSelection: contextSelection,
      ...modeFlags(),
      ...(attachments?.length ? { attachments } : {}),
      ...(mentions?.length ? { mentions } : {}),
    });
  };

  /**
   * Picks the interrupted run back up. Sent through the ordinary send path, so
   * every host code path this touches is the already-tested one that a typed
   * "continue" takes — the button is a shortcut, not a second mechanism.
   *
   * The error bubble is kept rather than removed (unlike handleRetry): it is
   * the record of what interrupted the run, and the resumed turn is an
   * addition to the conversation, not a replacement for it.
   */
  const handleResume = () => {
    if (isLoading || isStreaming) return;
    if (currentSessionId) stoppedSessionsRef.current.delete(currentSessionId);
    resetStreamBuffer();
    addMessage({ content: RESUME_MESSAGE, isUser: true, timestamp: Date.now() });
    setIsLoading(true);
    setIsStreaming(false);
    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      sessionId: currentSessionId,
      message: RESUME_MESSAGE,
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider,
      apiKey: selectedModelProvider?.apiKey,
      contextSelection: contextSelection,
      // The mode dial as it stands now, matching what typing "continue" would
      // do — a resume must not silently re-grant autonomy the user has since
      // switched off.
      ...modeFlags(),
    });
  };

  // Rewrite an earlier user message and re-ask from that point: the edited turn
  // and everything after it are dropped, then the new wording is sent as a
  // fresh turn. `historyOverride` carries the surviving prefix so the host's
  // model-facing history forks with the UI — without it the model would still
  // be answering the original question it can no longer see.
  const handleEditMessage = (index: number, newContent: string) => {
    // Mirrors the render gate that shows this control in the first place
    // (`!isLoading && !isStreaming`) — belt-and-suspenders in case a stale
    // render lets the action fire while a turn is still technically live.
    if (isLoading || isStreaming) return;
    const original = messages[index];
    if (!original?.isUser) return;

    setEditingIndex(null);

    const historyOverride = messages.slice(0, index).map((m) => ({
      content: m.content,
      isUser: m.isUser,
      isError: m.isError,
      writeReview: m.writeReview,
    }));
    // Mentions the user deleted while editing must not still be resolved.
    const mentions = activeMentions(newContent, new Set(original.mentions ?? []));

    truncateFrom(index);
    if (currentSessionId) stoppedSessionsRef.current.delete(currentSessionId);
    resetStreamBuffer();
    addMessage({
      content: newContent,
      isUser: true,
      ...(original.attachments?.length ? { attachments: original.attachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    });
    setIsLoading(true);
    setIsStreaming(false);

    vscode.postMessage({
      type: MESSAGE_TYPES.SEND_MESSAGE,
      sessionId: currentSessionId,
      message: newContent,
      modelId: selectedModelProvider?.selectedModel,
      provider: selectedModelProvider.provider,
      apiKey: selectedModelProvider?.apiKey,
      contextSelection: contextSelection,
      historyOverride,
      ...modeFlags(),
      ...(original.attachments?.length ? { attachments: original.attachments } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    });
  };

  const suggestions = buildSuggestions(myWorkItems, myWorkSprint, isConfluenceConnected);
  // Real ticket titles for history group headers whose stored title was cut
  // short by an older build.
  const ticketTitles = useMemo(
    () => new Map(myWorkItems.map((item) => [item.id, item.title] as const)),
    [myWorkItems]
  );

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
                <HomeGreeting />
                {isAdoConnected && (
                  <MyWorkPanel
                    items={myWorkItems}
                    currentSprintName={myWorkSprint}
                    isLoading={!myWorkLoaded}
                    error={myWorkError}
                    isRefreshing={myWorkRefreshing}
                    onRefresh={handleRefreshMyWork}
                    onSelect={handleSelectWorkItem}
                    onAutoRun={handleAutoRunWorkItem}
                  />
                )}
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
                        <span className='recent-chat-card-title'>
                          {runningSessionIds.has(session.id) && (
                            <span className='session-running-dot' title='Still working…' />
                          )}
                          {displaySessionTitle(session.title)}
                        </span>
                        <span className='recent-chat-card-date'>{formatRelativeTime(session.updatedAt)}</span>
                      </div>
                      <div className='recent-chat-card-arrow'>→</div>
                    </div>
                  ))
                )}
              </div>
              <div className='prompt-suggestions recent-chats-prompts'>
                <h2 className='prompt-suggestions-title'>Try asking</h2>
                <div className='prompt-suggestions-list'>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.label}
                      className='prompt-item'
                      onClick={() => handleStarterPrompt(suggestion.prompt)}
                    >
                      <span className='prompt-item-text'>{suggestion.label}</span>
                      <SuggestionArrow />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className='welcome-container'>
              <HomeGreeting />
              {isAdoConnected && (
                <MyWorkPanel
                  items={myWorkItems}
                  currentSprintName={myWorkSprint}
                  isLoading={!myWorkLoaded}
                  error={myWorkError}
                  isRefreshing={myWorkRefreshing}
                  onRefresh={handleRefreshMyWork}
                  onSelect={handleSelectWorkItem}
                  onAutoRun={handleAutoRunWorkItem}
                />
              )}
              <div className='prompt-suggestions'>
                <h2 className='prompt-suggestions-title'>Try asking</h2>
                <div className='prompt-suggestions-list'>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.label}
                      className='prompt-item'
                      onClick={() => handleStarterPrompt(suggestion.prompt)}
                    >
                      <span className='prompt-item-text'>{suggestion.label}</span>
                      <SuggestionArrow />
                    </button>
                  ))}
                </div>
              </div>
              <QuickTipsSection
                isConfluenceConnected={isConfluenceConnected}
                sessionCount={historyList.length}
                onOpenSettings={() => setActiveView('settings')}
              />
            </div>
          )
        ) : (
          <div className={`messages-container${editingIndex !== null ? ' messages-container--editing' : ''}`} ref={setMessagesRef} onScroll={handleMessagesScroll} onWheel={handleMessagesWheel}>
            {messages.map((message, index) => {
              if (editingIndex !== null && index > editingIndex) {
                return null;
              }
              return message.writeReview ? (
                <AgentWriteCard
                  key={message.writeReview.id}
                  review={message.writeReview}
                  onDecided={handleReviewDecided}
                />
              ) : (
                <ChatMessage
                  key={index}
                  content={message.content}
                  isUser={message.isUser}
                  isError={message.isError}
                  attachments={message.attachments}
                  agentSteps={message.agentSteps}
                  turnSummary={message.turnSummary}
                  timestamp={message.timestamp}
                  checkpointSha={message.isUser ? messages[index + 1]?.turnSummary?.checkpointSha : undefined}
                  isReverting={
                    message.isUser && revertingSha === messages[index + 1]?.turnSummary?.checkpointSha
                  }
                  onUndo={handleUndo}
                  onRetry={
                    message.isUser && messages[index + 1]?.isError
                      ? () => handleRetry(message.content, index + 1, message.attachments, message.mentions)
                      : undefined
                  }
                  resumable={message.isError ? message.resumable : undefined}
                  onResume={
                    // Only the LAST message may be resumed: an error further
                    // up was already answered by whatever follows it, and its
                    // transcript is long gone.
                    message.isError && message.resumable && index === messages.length - 1 && !isLoading && !isStreaming
                      ? handleResume
                      : undefined
                  }
                  onEdit={
                    // Editing forks the conversation — only offered on user
                    // messages, and never while a run is in flight.
                    message.isUser && !isLoading && !isStreaming
                      ? (newContent) => handleEditMessage(index, newContent)
                      : undefined
                  }
                  onEditingChange={
                    message.isUser
                      ? (editing) =>
                          setEditingIndex((prev) => (editing ? index : prev === index ? null : prev))
                      : undefined
                  }
                  onFeedback={
                    !message.isUser ? (rating) => handleFeedback(index, rating) : undefined
                  }
                  isLive={!message.isUser && isStreaming && index === messages.length - 1}
                />
              );
            })}
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
        {(showJumpToBottom || (pendingReview && reviewActionsOffscreen)) && (
          <div className='composer-affordances'>
            {pendingReview && reviewActionsOffscreen && (
              // The tool loop is blocked on this decision, so the buttons have
              // to be reachable without hunting for the card upstream.
              <div className='review-pin-bar'>
                <span className={`agent-write-kind kind-${pendingReview.kind}`}>
                  {REVIEW_KIND_LABEL[pendingReview.kind]}
                </span>
                <button
                  type='button'
                  className='review-pin-path'
                  title={
                    pendingReview.kind === 'command'
                      ? `${pendingReview.command ?? pendingReview.summary} — show it`
                      : `${pendingReview.path} — show the diff`
                  }
                  onClick={() => scrollToReview(pendingReview.id)}
                >
                  {pendingReview.kind === 'command'
                    ? pendingReview.command ?? pendingReview.summary
                    : pendingReview.path.split('/').pop() || pendingReview.path}
                </button>
                <span className='agent-write-stats'>
                  {pendingReview.diff.added > 0 && (
                    <span className='stat-added'>+{pendingReview.diff.added}</span>
                  )}
                  {pendingReview.diff.removed > 0 && (
                    <span className='stat-removed'>−{pendingReview.diff.removed}</span>
                  )}
                </span>
                <button
                  type='button'
                  className='review-pin-view'
                  onClick={() => scrollToReview(pendingReview.id)}
                >
                  {pendingReview.kind === 'command' ? 'View' : 'View diff'}
                </button>
                <button
                  type='button'
                  className='agent-write-approve'
                  onClick={() => decideReview(pendingReview.id, true)}
                >
                  ✓ Approve
                </button>
                <button
                  type='button'
                  className='agent-write-reject-open'
                  onClick={() => decideReview(pendingReview.id, false)}
                >
                  ✕ Reject
                </button>
              </div>
            )}
            {showJumpToBottom && (
              <button
                type='button'
                className='jump-to-bottom'
                title='Scroll to the latest message'
                onClick={() => pinToBottom('smooth')}
              >
                <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                  <path d='M12 5V19M12 19L6 13M12 19L18 13' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                </svg>
                Jump to latest
              </button>
            )}
          </div>
        )}
        <div className='composer-status-bars'>
          {mode === 'remote' && remoteSignedIn && remoteUsage && (
            <UsageLimitBar
              used={remoteUsage.used}
              limit={remoteUsage.limit}
              windowUsed={remoteUsage.windowUsed}
              windowLimit={remoteUsage.windowLimit}
              windowSeconds={remoteUsage.windowSeconds}
            />
          )}
          {hasWorkspaceFolder && <GitStatusBar />}
        </div>
        <div
          className={`input-container${isDraggingFile ? ' input-container--dragging' : ''}${editingIndex !== null ? ' input-container--muted' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes('Files')) {
              e.preventDefault();
              setIsDraggingFile(true);
            }
          }}
          onDragLeave={(e) => {
            // Only clear when leaving the container itself, not a child.
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDraggingFile(false);
          }}
          onDrop={handleComposerDrop}
        >
          <div className='input-wrapper'>
            {mentionQuery !== null && (
              <MentionPicker
                targets={mentionTargets}
                activeIndex={mentionIndex}
                query={mentionQuery}
                isSearching={mentionSearching}
                onSelect={insertMention}
                onHoverIndex={setMentionIndex}
              />
            )}
            {pendingAttachments.length > 0 && (
              <div className='composer-attachments'>
                {pendingAttachments.map((att, i) => (
                  <div key={`${att.name}-${i}`} className='attachment-chip' title={att.name}>
                    {att.kind === 'image' ? (
                      <img src={att.content} alt={att.name} className='attachment-chip-thumb' />
                    ) : (
                      <svg className='attachment-chip-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                        <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
                        <polyline points='14 2 14 8 20 8' />
                      </svg>
                    )}
                    <span className='attachment-chip-name'>{att.name}</span>
                    <button
                      type='button'
                      className='attachment-chip-remove'
                      onClick={() => removeAttachment(i)}
                      aria-label={`Remove ${att.name}`}
                      title='Remove'
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachmentNote && <div className='attachment-note'>{attachmentNote}</div>}
            <textarea
              ref={inputRef}
              rows={1}
              value={inputValue}
              onChange={handleComposerChange}
              onKeyDown={handleKeyDown}
              // Caret moves (arrows, clicks) can enter or leave an "@" token
              // without changing the text, so the picker re-syncs on those too.
              onKeyUp={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                  syncMentionPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
                }
              }}
              onClick={(e) => syncMentionPicker(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
              onBlur={closeMentionPicker}
              onPaste={handleComposerPaste}
              placeholder={
                mode === 'remote'
                  ? remoteSignedIn
                    ? 'Ask WorkspaceGPT...'
                    : 'Sign up with WorkspaceGPT in Settings to start chatting...'
                  : selectedModelProvider?.selectedModel
                    ? 'Ask WorkspaceGPT...'
                    : 'Please configure a model in Settings to start chatting...'
              }
            />
            <div className='input-controls'>
              <div className='input-selectors'>
                <input
                  ref={fileInputRef}
                  type='file'
                  multiple
                  accept='image/*,text/*,.md,.json,.yaml,.yml,.xml,.csv,.log,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.rb,.c,.h,.cpp,.cs,.sh,.sql,.toml,.ini,.env,.html,.css,.scss'
                  style={{ display: 'none' }}
                  onChange={handleFilePick}
                />
                <button
                  type='button'
                  className='attach-button action-btn'
                  onClick={() => fileInputRef.current?.click()}
                  disabled={pendingAttachments.length >= ATTACHMENT_LIMITS.MAX_FILES}
                  title='Attach files or images'
                  aria-label='Attach files or images'
                >
                  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                    <path d='M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                  </svg>
                </button>
                <button
                  type='button'
                  className='mode-chip'
                  onClick={() => setActiveView('settings')}
                  data-tooltip={
                    mode === 'remote'
                      ? 'Remote: answers come from WorkspaceGPT’s managed model. Your search index stays on this machine; only the question and retrieved snippets are sent. Click to change.'
                      : 'Local: chat model, embeddings and search index all run on this machine. Nothing leaves it. Click to change.'
                  }
                  data-tooltip-align='start'
                  aria-label={`${mode === 'remote' ? 'Remote' : 'Local'} mode. Click to change.`}
                >
                  {/* Dot only: mode is set once in Settings and rarely changed,
                      so the label was spending composer space on a constant.
                      The dot keeps the "where does my question go" signal and
                      carries the privacy note in its tooltip. */}
                  <span className={`mode-chip-dot mode-chip-dot--${mode}`} />
                </button>
                <div
                  className={`chat-mode-selector chat-mode-selector--${chatMode}`}
                  data-tooltip={CHAT_MODE_META[chatMode].title}
                >
                  <SearchableDropdown
                    value={chatMode}
                    searchable={false}
                    onChange={(value) => setChatModePersisted(value as ChatMode)}
                    options={CHAT_MODE_ORDER.map((m) => ({
                      value: m,
                      label: CHAT_MODE_META[m].label,
                    }))}
                  />
                </div>
                <div
                  className='context-selector-bottom'
                  data-tooltip={
                    contextSelection === 'Auto'
                      ? 'Where answers are grounded. Auto picks between your docs, tickets and code per question.'
                      : `Answers are grounded in ${contextSelection} only.`
                  }
                >
                  <SearchableDropdown
                    value={contextSelection}
                    onChange={setContextSelection}
                    searchable={false}
                    options={contextOptions}
                  />
                </div>
                {mode === 'local' && (
                  <div className='model-selector-bottom'>
                    <SearchableDropdown
                      value={selectedModelProvider?.provider ?? ''}
                      searchable={false}
                      onChange={(value) => {
                        if (value === 'selectModel') {
                          setActiveView('settings');
                          return;
                        }
                        const providerConfig = activeModels.find(
                          (model) => model.provider === value
                        );
                        handleModelChange(
                          providerConfig?.model!,
                          providerConfig?.provider!
                        );
                      }}
                      options={[
                        ...(activeModels?.length
                          ? activeModels.map((model) => ({
                              value: model.provider,
                              label: `${model.provider} (${model.model})`,
                            }))
                          : [{ value: 'none', label: 'Select Model' }]),
                        { value: 'selectModel', label: 'Edit...' },
                      ]}
                    />
                  </div>
                )}
                {hasWorkspaceFolder && <CreatePrButton />}
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
                  disabled={!inputValue.trim() && pendingAttachments.length === 0}
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
        <Releases
          isVisible={activeView === 'releases'}
          onBack={() => setActiveView('chat')}
          mode={mode}
          onOpenSettings={() => setActiveView('settings')}
        />
        <ChatHistorySidebar
          isVisible={activeView === 'history'}
          historyList={historyList}
          ticketTitles={ticketTitles}
          currentSessionId={currentSessionId}
          runningSessionIds={runningSessionIds}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onClose={() => setActiveView('chat')}
        />
      </div>
    </div>
  );
};

export default App;
