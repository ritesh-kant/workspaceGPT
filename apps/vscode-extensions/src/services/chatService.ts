import * as vscode from 'vscode';
import { ConfluenceEmbeddingService } from './confluence/confluenceEmbeddingService';
import path from 'path';
import { Worker } from 'worker_threads';
import {
  WORKER_STATUS,
  MESSAGE_TYPES,
  MODEL,
  ModelType,
  MODEL_PROVIDERS,
  STORAGE_KEYS,
  ChatAttachment,
} from '../../constants';
import { AdoEmbeddingService } from './ado/adoEmbeddingService';
import { JiraEmbeddingService } from './jira/jiraEmbeddingService';
import { AnalyticsService } from './analyticsService';
import { getLlmSettings } from 'src/utils/getLlmSettings';
import { getMode } from 'src/utils/getModeSettings';
import { withKeyFailover, isTransientServerError } from 'src/utils/apiKeyFailover';
// Shared with the webview's Resume button — see continuationIntent's header.
import { CONTINUATION_RE, APPROVAL_RE } from 'src/utils/continuationIntent';
import {
  saveResumeRecord,
  loadResumeRecord,
  clearResumeRecord,
  pruneResumeRecords,
  isAutoResumableFailure,
  describeAge,
} from './agent/resumeStore';
import { normalizeModelId } from 'src/utils/normalizeModelId';
import { getProviderDefaultHeaders } from 'src/utils/anthropicHeaders';
import { describeTurnOutcome } from 'src/utils/turnOutcome';
import { classifyQuery } from 'src/utils/queryClassifier';
import { buildPlan, expandQuery } from 'src/utils/queryPlanner';
import { rerank } from 'src/utils/reranker';
import {
  buildRepoOrientation,
  findFiles,
  findReferences,
  findSymbol,
  getNamedRoots,
  goToDefinition,
  listDirectory,
  NamedRoot,
  readFile,
  searchCodebase,
} from './codebase/codebaseTools';
import {
  DataSource,
  EmbeddingSearchResult,
  QueryClassification,
} from 'src/types/types';
import {
  applyWrite,
  prepareCreateFile,
  prepareDeleteFile,
  prepareEditFile,
  PreparedWrite,
} from './agent/agentWriteTools';
import { AgentWriteGate, buildReviewDiff } from './agent/agentWriteGate';
import { recordOriginalContent } from './agent/agentDiffProvider';
import { planVerification, rememberRecipe, verificationRecipesBlock, RunChecksArgs } from './agent/verifyTools';
import { shipChanges, ShipInput } from './agent/shipService';
import { deriveShipTitle } from './agent/shipHelpers';
import { CheckpointService, checkpointServiceFor } from './agent/checkpointService';
import { resolveMentions, ResolvedMention } from './codebase/mentionResolver';
import { TicketDetail } from './ado/adoWorkItemService';
import { getActiveTicketProvider } from './tickets/registry';
import { collectRefs, mergeRefs, refsFromTicket, RunRef } from './agent/referenceIndex';
import { getPrUrlTemplate } from './agent/gitStatusService';
import { fetchConfluencePage, ConfluencePageDetail } from './confluence/confluencePageService';
import { detectTicketId } from 'src/utils/ticketDetection';
import { detectConfluenceUrl } from 'src/utils/confluenceUrlDetection';
import { decideTurnRouting } from 'src/utils/turnRouting';
import { TicketPromptContext } from 'src/utils/promptTemplates';
import { PERMISSION_SEEKING_RE, PREMATURE_AMBIGUITY_RE } from 'src/workers/model/answerGates';
import { randomUUID } from 'crypto';
import { getDiagnostics, gitBlame, gitDiff, gitLog, gitStatus } from './agent/inspectTools';
import {
  agentOutputChannel,
  assertCommandAllowed,
  checkUnscopedVerification,
  REPO_WIDE_REQUEST_RE,
  MAX_TIMEOUT_SEC,
  executeCommand,
  recordAgentAudit,
  resolveCommandCwd,
  RunCommandArgs,
  CommandResult,
  isAutonomousSafeCommand,
  describeAutonomousRefusal,
} from './agent/commandTools';
import { loadWorkspaceRules } from './agent/rulesFiles';
import { searchWeb } from './webSearchTool';
import { RemoteSignInService } from './remote/remoteSignInService';
import { readLastSyncTime, SyncSection } from 'src/utils/syncStateStore';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One bubble of the webview transcript, as the webview serializes it. */
interface TranscriptEntry {
  content?: string;
  isUser?: boolean;
  isError?: boolean;
  writeReview?: unknown;
}

/**
 * Projects a webview transcript onto the model-facing history. Error bubbles
 * and write-review cards are UI artifacts, not conversation turns.
 */
const toModelHistory = (messages: TranscriptEntry[] | undefined): ChatMessage[] =>
  (messages || [])
    .filter((m) => !m.isError && !m.writeReview && !!m.content?.trim())
    .map((m) => ({ role: m.isUser ? ('user' as const) : ('assistant' as const), content: m.content as string }));

/**
 * Ticket screenshots ride in the model transcript as image_url parts. Those are
 * megabytes of base64 — cheap to keep in the live worker, ruinous to clone onto
 * the host and back through workerData on resume. Drop the bits, keep a note so
 * the next segment can re-fetch via get_ticket if it still needs them.
 */
const stripTranscriptImages = (messages: unknown[]): unknown[] =>
  messages.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const m = raw as { content?: unknown };
    if (!Array.isArray(m.content)) return raw;
    const filtered = m.content.filter((p: { type?: string }) => p?.type !== 'image_url');
    if (filtered.length === m.content.length) return raw;
    return {
      ...m,
      content: [
        ...filtered,
        {
          type: 'text',
          text: '[image(s) from the interrupted run were not re-attached — call get_ticket again if you still need them]',
        },
      ],
    };
  });

/** One structured agent-timeline step, as the webview renders it. */
interface AgentStepStart {
  /** Groupable kind: search | read | check | edit | command | thought | note | info. */
  kind: string;
  /** Verb-first label, e.g. "Searched", "Analyzed", "Edited". */
  title: string;
  /** Free-form payload after the title, e.g. the query or "#L150-250". */
  detail?: string;
  /** Workspace-relative file/dir path, when the step targets one (clickable in UI). */
  path?: string;
}

/** One applied file change within the current agent turn. */
interface TurnFileChange {
  path: string;
  kind: 'edit' | 'create' | 'delete';
  added: number;
  removed: number;
}

// Re-export for use within this file — keeps the rest of the class unchanged
type SearchResult = EmbeddingSearchResult;

/**
 * How long to let a saturated provider recover before spending a fresh worker
 * on it. By the time an error reaches the host, withKeyFailover has already
 * spent ~45s retrying inside the worker, so this is a second, longer pause on
 * top of that — long enough for a capacity blip to clear, short enough that a
 * real outage is reported rather than hidden behind minutes of waiting.
 */
const PROVIDER_RECOVERY_WAIT_MS = 30_000;

/**
 * What to tell the model when it is picking up a run that infrastructure cut
 * short.
 *
 * Different from the stall resume, and the difference matters. A stalled
 * segment ran out of steps and needs to be told that is not a blocker. This
 * one was interrupted mid-thought while doing fine, so the risk is the
 * opposite: re-reading files whose contents are already in the transcript, or
 * redoing an edit that is already on disk. Naming the real cause also stops
 * the model from theorising that its own last tool call broke something.
 */
function resumeAfterFailurePrompt(reason: string): string {
  return (
    `The previous attempt was cut off by an infrastructure failure, not by anything you did: ${reason} ` +
    'Everything above is work already completed — the searches, the file contents you read, and any edits already applied to disk. ' +
    'Continue from exactly where it stopped. Do not re-read a file whose contents are already above, and do not redo an edit the transcript shows as applied; ' +
    'if the transcript shows the fix applied AND verified, go straight to the final report. ' +
    'Otherwise finish the task now and deliver it.'
  );
}

/**
 * Markers that the previous assistant turn PROPOSED work rather than doing it.
 * A ticket opened from My Work is seeded with a prompt that asks for a plan
 * first (handleSelectWorkItem in the webview), and models volunteer plans
 * unprompted besides — so the approval that follows has to be recognised as
 * "carry out that plan", or the next turn just re-derives and re-proposes it.
 */
const PROPOSED_PLAN_RE =
  /(proposed plan|proposal|plan \(no code|files? to (change|modify|touch|edit)|shall i|should i (go|proceed|start|make|apply)|do you want me to|would you like me to|want me to|before (i|we) (touch|change|edit|modify)|(have|i have) not (yet )?(applied|made|touched)|no (code )?changes (yet|so far)|not yet applied any)/i;

/** TicketDetail → the trimmed, prompt-safe shape embedded in the worker prompt.
 * Images are stripped (they travel as multimodal parts, not prompt text) and
 * comments are capped — a long thread would crowd out the description. */
function toTicketPromptContext(t: TicketDetail): TicketPromptContext {
  const { images: _images, comments, ...rest } = t;
  return { ...rest, comments: comments?.slice(0, 5) };
}

/** How each source is named to the user — matches the context dropdown's labels. */
const SOURCE_LABELS: Record<DataSource, string> = {
  CONFLUENCE: 'Confluence',
  ADO: 'Azure DevOps',
  JIRA: 'Jira',
  CODEBASE: 'Codebase',
};

/**
 * Why an explicitly picked source is missing from `availableSources`, phrased
 * for the chat notice. Re-reads the same signals sendMessage gated on so it can
 * tell "never connected" apart from "connected but not indexed yet" — the two
 * need different fixes, and the notice is the only place the user is told which.
 */
function describeUnavailableSource(source: DataSource, settings: any): string {
  if (source === 'CODEBASE') {
    return 'no folder is open in this window';
  }
  const config = settings?.state?.config?.[source === 'ADO' ? 'ado' : 'confluence'];
  if (!config?.isAuthenticated) {
    return 'it is not connected yet, so connect it in Settings';
  }
  if (!config?.isIndexingCompleted) {
    return 'its index is not finished, so finish the sync in Settings';
  }
  return 'it is unavailable right now';
}

/**
 * All the state one chat session's run owns. Sessions are independent: each
 * has its own model-facing history, its own (at most one) live worker, its
 * own write gate and its own turn rollup — so several chats can run at once
 * without leaking chunks, steps or approvals into each other.
 */
interface SessionRun {
  sessionId: string;
  chatHistory: ChatMessage[];
  worker: Worker | null;
  reject: ((reason?: any) => void) | null;
  /** Human-approval gate for this session's agent write tools. */
  writeGate: AgentWriteGate;
  /** Set on stop: everything the dying run still emits is dropped host-side. */
  cancelled: boolean;
  turnStartMs: number;
  /** File-change rollup for the current agent turn (path → cumulative counts). */
  turnFilesChanged: Map<string, TurnFileChange>;
  /**
   * Ids this turn's tools actually returned, with what each one refers to.
   * Travels to the webview on the turn summary so the answer's `#12359` links
   * to the pull request it came from instead of a same-numbered work item —
   * see referenceIndex.ts for why the renderer cannot work this out alone.
   */
  turnRefs: RunRef[];
  /** `origin`'s PR url template for this turn's workspace — stamped onto pull-request refs as they are recorded. */
  turnPrUrlTemplate?: string;
  /**
   * Structured steps posted for the current turn. Counted so a turn that ends
   * with no prose can be described truthfully — zero steps and zero writes is
   * a failed turn, not a quiet success (see describeTurnOutcome).
   */
  turnStepsPosted: number;
  /**
   * The user's own message asked for a repo-wide check ("run the full test
   * suite"). Set per turn: it lifts the unscoped-verification refusal, since a
   * wide run the user asked for is not the harness's call to override.
   */
  userAskedRepoWide: boolean;
  /**
   * Writes applied across the WHOLE session, never cleared per turn. Passed to
   * the worker as `priorWrites` so the delivery-time honesty stamp can tell a
   * fabricated completion report ("## Done", invented Changes list, zero
   * writes ever) apart from a truthful recap of a previous turn's real edits.
   */
  sessionWritesApplied: number;
  /** What "Create PR" ships: the last turn that changed files, with its report and ticket. */
  lastShip: ShipInput | null;
  /**
   * The most recent context-window reading for this session, as posted to the
   * webview. Replayed when the chat is reopened — the webview's own copy dies
   * with a panel reload, and a meter that reads 0% on a long conversation is
   * worse than no meter at all.
   */
  lastContext: Record<string, unknown> | null;
  /** First checkpoint of the turn — the "undo this turn" target. */
  turnFirstCheckpointSha: string | null;
  /**
   * Applied-write counter for the turn. Verification results are only valid
   * for the tree they ran against, so this is the cache key's version: any
   * applied write invalidates every remembered check.
   */
  writeSeq: number;
  /**
   * Verification results already produced this turn, keyed by the derived
   * command + cwd. In a monorepo `run_checks` derives the SAME package-wide
   * command for every file in a package, so a three-file change would
   * otherwise run one test suite three times (and the loop's own
   * auto-verification pass makes that the common case, not the rare one).
   */
  checkRuns: Map<string, { writeSeq: number; result: unknown }>;
  /**
   * Checks currently EXECUTING, same key as {@link checkRuns}. The result
   * cache can only replay a command that already finished, so once the
   * auto-verification pass started running a round's checks concurrently, two
   * files in one package deriving the same package-wide command (`pnpm run
   * tsc`, a shared suite) both missed the cache and both ran — the concurrency
   * undoing the very saving the cache existed for. Joining the in-flight
   * promise makes that one process again, whatever the call order.
   */
  checkInFlight: Map<string, Promise<unknown>>;
  /**
   * Executables this turn already proved are not installed — exit 127, keyed
   * by the command's first word, holding the output of the attempt that found
   * out. Unlike {@link checkRuns} this is NOT invalidated by a write: whether
   * `pnpm` exists on the PATH has nothing to do with the contents of the
   * files being checked, so the write-seq cache let the same impossible
   * command run again after every edit.
   *
   * Ticket #1534774 ran nine of them (`pnpm exec jest` twice, `pnpm exec
   * eslint` twice, `pnpm run tsc` twice, …), each one a full model turn at
   * ~100k tokens of context, and still reported "could not verify".
   *
   * Per TURN, not per session: the user may well fix their PATH and ask again,
   * and re-learning it costs one call instead of nine.
   */
  missingExecutables: Map<string, string>;
  /**
   * Click-to-run mode for the CURRENT turn: file writes and allowlisted
   * test/build commands apply without a review card (still checkpointed and
   * audited as decision 'auto'). Set per sendMessage call — never sticky, so a
   * manual follow-up message in the same session gets the gates back.
   */
  autonomous: boolean;
  /**
   * Chat or Work, as of this session's last turn. The host is the authority on
   * this — the webview's live switch reflects whichever chat is on screen, so
   * a background session saved while the user is looking at a different mode
   * would be filed under the wrong one if the save carried the UI's value.
   */
  assistantMode: 'chat' | 'work';
  /**
   * Model-facing transcript (tool calls and their results included) of an agent
   * turn that was interrupted before it delivered an answer — a provider error,
   * a crashed/stalled worker, or the user pressing stop. Streamed up from the
   * worker at every round boundary, because that array lives inside the worker
   * thread and dies with it.
   *
   * A continuation reply ("continue", "fix it", "go ahead") resumes from this
   * instead of starting a fresh run, which would otherwise re-explore the whole
   * repo and redo work already on disk. Cleared as soon as a turn delivers an
   * answer, or when the user's next message shows they moved on — the raw tool
   * results are far too expensive to carry through a whole session.
   */
  agentTranscript: unknown[] | null;
  /**
   * Whether the last delivered answer was stall-shaped with zero writes, as
   * judged by the worker (which knows writesApplied) when it sent 'done'.
   * Drives the autonomous auto-resume in sendMessage: a stall on a fresh
   * worker gets a fresh tool budget, which is the cure when the previous run
   * exhausted its budget and skipped the honesty gates.
   */
  lastAnswerStallShaped: boolean;
  /**
   * The work item the most recent turn was grounded in, kept so a resume
   * record parked on disk can name what it was working on when the user comes
   * back to it in a new window.
   */
  lastTicketId: string | null;
}

export class ChatService {
  private embeddingService: ConfluenceEmbeddingService;
  private adoEmbeddingService: AdoEmbeddingService;
  private jiraEmbeddingService: JiraEmbeddingService;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private currentModel: string;
  /** Per-chat-session run state, keyed by the webview's sessionId. */
  private runs = new Map<string, SessionRun>();
  /** Shadow-git checkpoints, created lazily per workspace root on the first write. */
  private checkpointServices = new Map<string, CheckpointService>();
  /** Shadow repository root for each checkpoint exposed to this live chat. */
  private checkpointRootsBySha = new Map<string, string>();
  /** Commands the user approved "for this session" (exact string match). */
  private sessionCommandAllowlist = new Set<string>();
  /** When the in-flight turn started — reported as "Worked for Xs". */
  /** Files changed (applied writes only) during the in-flight turn, keyed by display path. */
  /** Sha of the FIRST checkpoint taken this turn — reverting to it undoes the whole turn. */

  constructor(
    webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext,
    /**
     * Optional so existing callers keep working; passed in (rather than
     * constructed here) to reuse the handler's single PostHog client instead of
     * spawning a second one with its own queue and flush timer.
     */
    private readonly analyticsService?: AnalyticsService
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.embeddingService = new ConfluenceEmbeddingService(webviewView, context);
    this.adoEmbeddingService = new AdoEmbeddingService(webviewView, context);
    this.jiraEmbeddingService = new JiraEmbeddingService(webviewView, context);
    this.currentModel = MODEL.DEFAULT_CHAT_MODEL;
    // Housekeeping, once per activation: an interrupted run the user never
    // came back to would otherwise keep its transcript in global storage
    // forever. Anything past MAX_RESUME_AGE_MS could not be resumed anyway.
    void pruneResumeRecords(this.resumeDir);
  }

  /**
   * Eagerly spawns + warms the persistent search worker(s) so the first query is fast.
   * Only warms a source that is actually authenticated and indexed, so we don't load
   * the embedding model into memory for a source the user hasn't connected.
   * Fire-and-forget: safe to call on webview activation.
   */
  public prewarm(): void {
    const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
    const isConfluenceConnected =
      settings?.state?.config?.confluence?.isAuthenticated &&
      settings?.state?.config?.confluence?.isIndexingCompleted;
    const isAdoConnected =
      settings?.state?.config?.ado?.isAuthenticated &&
      settings?.state?.config?.ado?.isIndexingCompleted;
    const isJiraConnected =
      settings?.state?.config?.jira?.isAuthenticated &&
      settings?.state?.config?.jira?.isIndexingCompleted;

    if (isConfluenceConnected) {
      this.embeddingService.eagerInit();
    }
    if (isAdoConnected) {
      this.adoEmbeddingService.eagerInit();
    }
    if (isJiraConnected) {
      this.jiraEmbeddingService.eagerInit();
    }
  }

  /**
   * Tear down the persistent search workers this service owns. Call on reset/deactivation.
   */
  public dispose(): void {
    // Terminate every session's live worker — nothing can receive their
    // output once this service (and its webview) is gone.
    this.stopMessage();
    this.embeddingService.dispose();
    this.adoEmbeddingService.dispose();
    this.jiraEmbeddingService.dispose();
  }

  public async initializeModel(
    modelId: string,
    modelType: ModelType
  ): Promise<void> {
    try {
      const workerPath = path.join(
        __dirname,
        'workers',
        'model',
        'modelDownloader.js'
      );
      const modelWorker = new Worker(workerPath, {
        workerData: {
          modelId,
          modelType,
          globalStoragePath: this.context.globalStorageUri.fsPath,
        },
      });

      // Keep track of the last progress update to avoid flooding UI
      let lastProgressUpdate = 0;
      const PROGRESS_UPDATE_THROTTLE = 2000; // ms

      return new Promise((resolve, reject) => {
        modelWorker.on(
          'message',
          (result: {
            type: string;
            message?: string;
            progress?: string;
            current?: string;
            total?: string;
            models?: any[];
            modelId?: string;
            modelType?: ModelType;
          }) => {
            if (result.type === WORKER_STATUS.PROCESSING) {
              const now = Date.now();
              // Only send progress updates at most every PROGRESS_UPDATE_THROTTLE ms
              if (now - lastProgressUpdate > PROGRESS_UPDATE_THROTTLE) {
                lastProgressUpdate = now;

                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS,
                  progress: result.progress,
                  current: result.current ?? '0 MB',
                  total: result.total ?? '0 MB',
                  modelId: result.modelId ?? '',
                  modelType: result.modelType,
                });
              }
            } else if (result.type === 'error') {
              console.error('Model initialization error:', result.message);
              this.webviewView.webview.postMessage({
                type: MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR,
                message: result.message,
              });
              reject(new Error(result.message));
              modelWorker.terminate();
            } else if (
              result.type === 'response' ||
              result.type === WORKER_STATUS.COMPLETED
            ) {
              this.currentModel = modelId;
              // Send final complete message
              this.webviewView.webview.postMessage({
                type: MESSAGE_TYPES.MODEL_DOWNLOAD_COMPLETE,
                models: result.models,
              });
              console.log(`Model ${modelId} initialized successfully`);
              resolve();
              modelWorker.terminate();
            }
          }
        );

        modelWorker.on('error', (error) => {
          console.error('Worker error during model initialization:', error);
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR,
            message: error.message,
          });
          reject(error);
          modelWorker.terminate();
        });
      });
    } catch (error) {
      console.error('Error initializing model:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.MODEL_DOWNLOAD_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Where interrupted runs are parked so they survive a window reload — its
   * own folder, never `chats/`, because HistoryService JSON-parses every file
   * in there to render the history list (see resumeStore's header).
   */
  private get resumeDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'agent-resume');
  }

  /**
   * Trailing-edge persistence of a session's transcript.
   *
   * The worker mirrors its conversation up at every round boundary, and a
   * ticket run's transcript is hundreds of KB, so writing on each of those
   * would be a lot of disk for a file that is usually thrown away. Throttled
   * instead, with the terminal paths (error, stall, stop) flushing
   * immediately — those are the ones that matter, and by then no further
   * rounds are coming. The delay is what covers the case no terminal path
   * can: the extension host itself going down.
   */
  private resumeSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly RESUME_SAVE_DEBOUNCE_MS = 4_000;

  /**
   * Serializes a session's resume writes and deletes against each other.
   *
   * Without this they are independent floating promises, and the losing order
   * is real: `forgetResume` fires a delete when a turn delivers, the next turn
   * starts and schedules a save, and a slow delete landing after that save
   * would remove a record for a run that is currently interrupted. One chain
   * per session makes the last call the last effect.
   */
  private resumeIO = new Map<string, Promise<void>>();

  private queueResumeIO(sessionId: string, op: () => Promise<void>): Promise<void> {
    const next = (this.resumeIO.get(sessionId) ?? Promise.resolve()).then(op, op);
    this.resumeIO.set(sessionId, next);
    return next;
  }

  private scheduleResumeSave(run: SessionRun, reason: string): void {
    if (this.resumeSaveTimers.has(run.sessionId)) return;
    this.resumeSaveTimers.set(
      run.sessionId,
      setTimeout(() => {
        this.resumeSaveTimers.delete(run.sessionId);
        void this.flushResumeSave(run, reason);
      }, ChatService.RESUME_SAVE_DEBOUNCE_MS)
    );
  }

  private async flushResumeSave(run: SessionRun, reason: string): Promise<void> {
    const timer = this.resumeSaveTimers.get(run.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.resumeSaveTimers.delete(run.sessionId);
    }
    if (!run.agentTranscript?.length) return;
    // Snapshot the array: the worker keeps appending to it, and the write is
    // serialized behind whatever else is queued for this session.
    const transcript = run.agentTranscript.slice();
    await this.queueResumeIO(run.sessionId, async () => {
      await saveResumeRecord(this.resumeDir, {
        sessionId: run.sessionId,
        savedAt: Date.now(),
        transcript,
        reason,
        writesApplied: run.sessionWritesApplied,
        ticketId: run.lastTicketId ?? undefined,
      });
    });
  }

  /**
   * Stops carrying an interrupted run in THIS process, without discarding it.
   *
   * For "the user moved on": their next message wasn't a continuation, so the
   * stranded transcript must not be prefixed onto an unrelated question (its
   * raw tool results are tens of thousands of tokens). The disk record stays,
   * because a message that isn't a continuation is not the same thing as a
   * decision to throw the work away — a later "continue" can still recover
   * it, announced with its age, and it prunes itself after MAX_RESUME_AGE_MS
   * regardless.
   */
  private dropResumeFromMemory(run: SessionRun): void {
    const timer = this.resumeSaveTimers.get(run.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.resumeSaveTimers.delete(run.sessionId);
    }
    run.agentTranscript = null;
  }

  /**
   * Drops both copies — for a run that actually FINISHED. A record left behind
   * here would offer to resume a completed run.
   */
  private forgetResume(run: SessionRun): void {
    const timer = this.resumeSaveTimers.get(run.sessionId);
    if (timer) {
      clearTimeout(timer);
      this.resumeSaveTimers.delete(run.sessionId);
    }
    run.agentTranscript = null;
    void this.queueResumeIO(run.sessionId, () => clearResumeRecord(this.resumeDir, run.sessionId));
  }

  /**
   * Brings a stranded run back from disk when this process has no memory of
   * it — a reloaded window, or a session reopened from history. Returns the
   * record so the caller can tell the user how old the work is.
   */
  private async hydrateResume(run: SessionRun): Promise<{ steps: number; age: string } | null> {
    if (run.agentTranscript?.length) return null;
    // Behind the same chain, so a read never overtakes a pending write.
    await this.queueResumeIO(run.sessionId, async () => {});
    const record = await loadResumeRecord(this.resumeDir, run.sessionId);
    if (!record) return null;
    run.agentTranscript = record.transcript;
    return { steps: record.transcript.length, age: describeAge(record.savedAt) };
  }

  /** Gets (or lazily creates) the run state for one chat session. */
  private runFor(sessionId: string): SessionRun {
    let run = this.runs.get(sessionId);
    if (!run) {
      run = {
        sessionId,
        chatHistory: [],
        worker: null,
        reject: null,
        writeGate: new AgentWriteGate(),
        cancelled: false,
        turnStartMs: 0,
        turnFilesChanged: new Map(),
        turnRefs: [],
        turnStepsPosted: 0,
        userAskedRepoWide: false,
        sessionWritesApplied: 0,
        lastShip: null,
        lastContext: null,
        turnFirstCheckpointSha: null,
        writeSeq: 0,
        checkInFlight: new Map(),
        checkRuns: new Map(),
        missingExecutables: new Map(),
        autonomous: false,
        assistantMode: 'work',
        agentTranscript: null,
        lastAnswerStallShaped: false,
        lastTicketId: null,
      };
      this.runs.set(sessionId, run);
    }
    return run;
  }

  /**
   * Posts a session-stamped message to the webview, which routes it to the
   * chat it belongs to (visible or backgrounded). Dropped once the session's
   * run has been stopped — a dying run's stragglers must not reach the UI.
   */
  private post(run: SessionRun, payload: { type: string; [key: string]: unknown }): void {
    if (run.cancelled) return;
    // The single choke point for everything the webview sees, so it is also
    // the only honest place to count what this turn actually surfaced.
    if (payload.type === MESSAGE_TYPES.AGENT_STEP) run.turnStepsPosted++;
    this.webviewView.webview.postMessage({ ...payload, sessionId: run.sessionId });
  }

  /** Local-only: Worker already 401'd this session. Keep the Account card in sync. */
  private async forgetInvalidRemoteSession(): Promise<void> {
    await new RemoteSignInService(this.context).clearLocalSession();
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS });
  }

  /**
   * Stops one session's run (or, with no sessionId, every run — the dispose
   * path). Later output from the stopped run is swallowed by `post`.
   */
  public stopMessage(sessionId?: string): void {
    const targets = sessionId
      ? [this.runs.get(sessionId)].filter((r): r is SessionRun => !!r)
      : [...this.runs.values()];
    for (const run of targets) {
      // Unpark any write approvals first — their worker is about to die — and
      // tell the webview so pending cards don't keep live-looking buttons.
      run.writeGate.rejectAll('Run stopped by the user.');
      this.post(run, { type: MESSAGE_TYPES.AGENT_WRITE_REVIEWS_CLOSED });
      run.cancelled = true;
      if (run.worker) {
        run.worker.terminate();
        run.worker = null;
        if (run.reject) {
          run.reject(new Error('Generation cancelled by user.'));
          run.reject = null;
        }
      }
    }
  }

  /** Sends a transient status label to the webview loading indicator. */
  private postStatus(run: SessionRun, text: string): void {
    this.post(run, {
      type: MESSAGE_TYPES.RETRIEVAL_STATUS,
      text,
    });
  }

  /**
   * Seeds a session's model-facing history from its stored transcript when
   * the user opens it from history. Skipped while the session has a live
   * run — its in-memory history is already ahead of what's on disk.
   */
  public loadHistory(sessionId: string, messages: TranscriptEntry[]): void {
    const run = this.runFor(sessionId);
    if (run.worker) return;
    run.chatHistory = toModelHistory(messages);
    // The stored transcript is the rendered conversation, not the model-facing
    // tool trace, so there is nothing here to resume from. Drop the in-memory
    // copy so another session's stranded run can't be reused — but leave this
    // session's record on DISK alone: reopening a chat whose run died is
    // exactly when it should still be resumable, and sendMessage reloads it
    // when the user asks to continue.
    this.dropResumeFromMemory(run);
  }

  /** The last context reading this session produced, for replay on reopen. */
  public lastContextFor(sessionId: string): Record<string, unknown> | null {
    return this.runs.get(sessionId)?.lastContext ?? null;
  }

  /**
   * Which mode this session's turns ran under, for filing its history. Absent
   * for a session this host has not run a turn for (a transcript restored from
   * disk keeps whatever it was already saved with).
   */
  public assistantModeFor(sessionId: string): 'chat' | 'work' | undefined {
    return this.runs.get(sessionId)?.assistantMode;
  }

  public async newChat(): Promise<void> {
    // Session state is per-sessionId — a new chat simply starts under a fresh
    // id on its first send. Just tell the webview to show a fresh chat.
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.NEW_CHAT,
    });
  }

  public async sendMessage(
    sessionId: string,
    message: string,
    modelId: string,
    apiKey: string,
    provider: string,
    contextSelection: string = 'Auto',
    attachments: ChatAttachment[] = [],
    mentions: string[] = [],
    /**
     * Set when the user edited an earlier message: the surviving transcript
     * prefix, which replaces this session's model-facing history so it forks
     * with the UI instead of still carrying the original wording and the
     * answers that followed from it.
     */
    historyOverride?: TranscriptEntry[],
    /**
     * Click-to-run: the user started this turn from a ticket's Run button and
     * is not reviewing each step. Gates writes open (see gatedWrite) and
     * allowlisted test/build commands (see gatedCommand); everything else is
     * unchanged — same loop, same checkpoints, same audit log.
     */
    autonomous = false,
    /**
     * Plan mode: this turn's deliverable is a reviewable plan — the worker
     * prompt forbids writes and the anti-plan gates are disarmed. The user's
     * approving reply then runs as the executeMandate turn.
     */
    planMode = false,
    /**
     * The Chat/Work switch. 'work' (default) behaves exactly as before —
     * Confluence, Azure DevOps and the codebase are all in play per the usual
     * facts-based gating. 'chat' is a plain conversation: this turn's facts
     * are forced false below so no retrieval runs and no codebase/Confluence/
     * ticket tools are offered, regardless of what's connected or open.
     */
    assistantMode: 'chat' | 'work' = 'work'
  ): Promise<void> {
    const run = this.runFor(sessionId);
    if (run.worker) {
      // The webview blocks sending while a session's run is live; if a send
      // slips through anyway, refuse rather than orphan the running worker.
      this.post(run, {
        type: MESSAGE_TYPES.ERROR_CHAT,
        message: 'A response is already being generated for this chat. Stop it first or wait for it to finish.',
      });
      return;
    }
    run.cancelled = false;
    // Safe to replace unconditionally here: the live-worker case already
    // returned above, so nothing is mid-turn against the old history.
    if (historyOverride) {
      run.chatHistory = toModelHistory(historyOverride);
    }
    try {
      // An attachment-only send still needs a non-empty question for
      // classification and the prompt template.
      if (!message?.trim() && attachments.length > 0) {
        message = 'Please review the attached file(s).';
      }
      // Model-facing history keeps a lightweight marker per attachment — the
      // full content is only injected into the current turn's prompt (text)
      // or sent as image parts (images); replaying megabytes of base64 into
      // every later turn would blow the context window.
      const historyContent = attachments.length
        ? `${message}\n[Attached: ${attachments.map((a) => a.name).join(', ')}]`
        : message;
      // @-mentions stay in `message` verbatim, so the history line already
      // records what the user pointed at — only their resolved contents are
      // turn-scoped (see resolvedMentions below).
      run.chatHistory.push({ role: 'user', content: historyContent });
      run.turnStartMs = Date.now();
      run.userAskedRepoWide = REPO_WIDE_REQUEST_RE.test(message);
      run.turnFilesChanged.clear();
      run.turnRefs.length = 0;
      run.turnStepsPosted = 0;
      run.turnFirstCheckpointSha = null;
      run.writeSeq = 0;
      run.checkRuns.clear();
      // A promise left here would be against the previous turn's tree.
      run.checkInFlight.clear();
      run.missingExecutables.clear();

      const mode = getMode(this.context);

      // ── Autonomy dial ──
      // Autonomous runs auto-apply writes, which a 14B-class local model can't
      // be trusted with: require a cloud provider, and degrade to the normal
      // review-gated flow (with a visible notice) rather than refusing the run.
      if (autonomous && mode !== 'remote' && (provider ?? '').toLowerCase() === 'ollama') {
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP,
          step: {
            kind: 'notice',
            title: 'Autonomous runs need a cloud model — continuing with the usual per-change approvals instead.',
            status: 'error',
          },
        });
        autonomous = false;
      }
      run.autonomous = autonomous;
      run.assistantMode = assistantMode;

      // All configured keys for the selected provider, tried in failover order
      // on 429. Local mode: the webview's selected model + its stored keys.
      // Remote mode: the WorkspaceGPT Worker's base URL with the account
      // session token as the key — one managed model for every task, chosen
      // server-side. Falls back to the single key the webview sent.
      const chatLlm = getLlmSettings(this.context);
      const apiKeys = chatLlm.apiKeys;
      const failoverKeys = apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];
      // 'Custom' provider's user-supplied base URL (undefined for built-in
      // providers, which resolve their base URL from MODEL_PROVIDERS instead).
      const baseUrl = chatLlm.baseUrl;

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      // Chat mode is the one deliberate, session-level override of "capability
      // is a fact": the user asked for a plain conversation, so Confluence, ADO
      // and the codebase are facts that read as false for this turn — same
      // mechanism the fact-based gates below already use, not a text guess.
      const isWorkMode = assistantMode !== 'chat';
      const isConfluenceConnected =
        isWorkMode &&
        settings?.state?.config?.confluence?.isAuthenticated &&
        settings?.state?.config?.confluence?.isIndexingCompleted;
      const isAdoConnected =
        isWorkMode &&
        settings?.state?.config?.ado?.isAuthenticated &&
        settings?.state?.config?.ado?.isIndexingCompleted;
      const isJiraConnected =
        isWorkMode &&
        settings?.state?.config?.jira?.isAuthenticated &&
        settings?.state?.config?.jira?.isIndexingCompleted;

      const userDisplayName: string = settings?.state?.config?.ado?.userDisplayName || '';
      const currentSprint = settings?.state?.config?.ado?.currentSprint || null;

      // Codebase tools need no auth/indexing — only an open workspace folder.
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      const isCodebaseAvailable = isWorkMode && workspaceFolders.length > 0;

      // What the worker may be OFFERED this turn, from facts only. Gated on
      // authentication rather than index completion: `get_ticket` and
      // `get_confluence_page` are live API calls that work without an index,
      // and the search tools already report an unindexed source as a plain
      // tool error the model can read. Never derived from the message text —
      // see toolScope.ts for why.
      const toolAvailability = {
        codebase: isCodebaseAvailable,
        confluence: isWorkMode && !!settings?.state?.config?.confluence?.isAuthenticated,
        tickets: isWorkMode && !!getActiveTicketProvider(this.context),
      };

      // Read the @-mentioned files/folders while retrieval runs — they are
      // local reads, so overlapping them with the search costs nothing and
      // keeps them off the critical path. Awaited just before the model runs.
      const mentionsPromise: Promise<ResolvedMention[]> = mentions.length
        ? resolveMentions(mentions, getNamedRoots(workspaceFolders)).catch((error) => {
            console.warn('Failed to resolve @-mentions (continuing without):', error);
            return [];
          })
        : Promise.resolve([]);

      // Build the list of actually-connected sources
      const availableSources: DataSource[] = [
        ...(isConfluenceConnected ? ['CONFLUENCE' as DataSource] : []),
        ...(isAdoConnected ? ['ADO' as DataSource] : []),
        ...(isJiraConnected ? ['JIRA' as DataSource] : []),
        ...(isCodebaseAvailable ? ['CODEBASE' as DataSource] : []),
      ];

      const trimmedMessage = message.trim();

      // ── A stranded run is carried because it EXISTS, not because the reply
      // was phrased a particular way ──
      // This used to be gated on isContinuationIntent(message): match, and the
      // interrupted run was resumed; miss, and its transcript was dropped. The
      // resume record is one slot per session, and the fresh run overwrites it
      // as soon as it streams its own transcript — so a miss did not defer the
      // work, it destroyed it. And the patterns miss most of how people
      // actually reply: "go ahead, apply all four edits", "ok now fix it",
      // "yes do it please", "please apply the fix we discussed" and any typo
      // or non-English phrasing all fell through to the destroying branch.
      //
      // The costs are wildly asymmetric — carrying a transcript the user did
      // not want costs some prompt tokens and is visible in the timeline;
      // dropping one they did want loses an entire investigation and cannot be
      // undone — so the default is now to carry. A record only exists at all
      // when a previous run did NOT finish (a delivered answer clears both
      // copies in forgetResume), which is exactly when the next message is
      // overwhelmingly likely to be about it. If it is not, the continuation
      // prompt still quotes the user's new message as the thing to answer.
      const revived = await this.hydrateResume(run);
      if (revived) {
        this.postStatus(run, `Recovering the interrupted run (saved ${revived.age})...`);
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP,
          step: {
            kind: 'info',
            title: `Recovered the interrupted run from ${revived.age}`,
            detail: `${revived.steps} model message(s) carried over`,
          },
        });
      }
      if (run.agentTranscript?.length) {
        console.log(
          `Resuming the interrupted agent run for this session (${run.agentTranscript.length} model messages carried over).`
        );
      }

      // ── Step 1: Rule-based classification (synchronous, zero latency) ──
      let classification: QueryClassification = classifyQuery(message, availableSources);

      // (Routing inheritance for bare "continue"/"go ahead" replies used to live
      // here, so a continuation kept its codebase tools and a parked resume
      // transcript was not dropped. Tools are now granted from facts below —
      // whenever a folder is open — so a continuation needs no help to keep
      // them, and the resume transcript is carried whenever roots are passed.)

      // Approval of a plan the previous turn proposed makes THIS turn an
      // execution turn. Deliberately not gated on contextSelection: unlike the
      // routing inheritance above, "carry out what you just proposed" is true
      // regardless of which context the user picked. Without this the next turn
      // re-derives the same investigation and proposes it again — observed live
      // as three consecutive "here's the plan, shall I proceed?" turns on one
      // ADO bug, because the seeded ticket prompt says "before changing
      // anything" and nothing ever revokes that.
      const priorAssistant =
        [...run.chatHistory].reverse().find((m) => m.role === 'assistant')?.content ?? '';
      const executeMandate =
        trimmedMessage.length <= 80 &&
        (APPROVAL_RE.test(trimmedMessage) || CONTINUATION_RE.test(trimmedMessage)) &&
        PROPOSED_PLAN_RE.test(priorAssistant);
      if (executeMandate) {
        console.log('User approved a proposed plan — this turn executes it.');
      }


      // Override sources when the user has explicitly chosen a context.
      //
      // `unhonoredSelection` records an explicit pick that could NOT be applied:
      // the label maps to a real source, but that source isn't in
      // `availableSources` (Confluence/ADO not connected or still unindexed, or
      // Codebase with no folder open). Neither branch below fires in that case,
      // so `classification` keeps its rule-based sources and the turn proceeds
      // as if the user had left it on Auto. The picker only ever narrows what
      // is pre-fetched — tools are decided from facts below, not from it — so
      // an unhonored pick changes what gets searched, never what the model can
      // do. It used to be completely silent; the notice posted after routing
      // settles is what makes it visible.
      //
      // ── Capability is a FACT, not a guess ──
      // The decision itself lives in utils/turnRouting.ts (pure, pinned by the
      // headless unit tests) — see its docblock for why tools are granted from
      // "a folder is open" alone and the classifier only decides what is
      // PRE-FETCHED (Step 3 below). In short: a wrong guess about what to
      // pre-fetch costs one round-trip, never an ability. With no folder open
      // the pre-fetch set is the whole answer path, exactly as before.
      const routing = decideTurnRouting({
        isCodebaseAvailable,
        availableSources,
        classification,
        // Chat mode already zeroed availableSources above; forcing 'Auto' here
        // stops a stale Confluence/ADO picker choice (made before switching to
        // Chat) from reporting itself as "unhonored" for a source that was
        // never in play this turn.
        contextSelection: isWorkMode ? contextSelection : 'Auto',
      });
      const { useCodebaseTools } = routing;
      classification = routing.classification;
      const unhonoredSelection: { label: string; reason: string } | null = routing.unhonoredSource
        ? {
            label: SOURCE_LABELS[routing.unhonoredSource],
            reason: describeUnavailableSource(routing.unhonoredSource, settings),
          }
        : null;

      // The user's explicit context pick could not be honored. Routing has
      // settled by now, so the notice can name what ran instead — and it can't
      // change again: the only remaining re-route (the LLM one in Step 3) is
      // gated on `contextSelection === 'Auto'`, which is false on this path.
      // Sent as a 'notice' step rather than a status label because every status
      // label posted here is overwritten within milliseconds by "Searching …"
      // or "Thinking…"; a step is pinned to the answer, so it also survives a
      // reload and shows up when the chat is reopened from history.
      if (unhonoredSelection) {
        // Mirror what Step 3 will actually do rather than just reading
        // `classification.sources`: a chitchat turn plans topKPerPass=0, so it
        // searches nothing even with sources set, and claiming it used
        // Confluence would be a second wrong statement on top of the first.
        const searchedInstead =
          classification.intent !== 'chitchat' && classification.sources.length
            ? classification.sources.map((s) => SOURCE_LABELS[s]).join(' & ')
            : null;
        const usedInstead =
          [useCodebaseTools ? 'the codebase' : null, searchedInstead].filter(Boolean).join(' and ') || null;
        const notice =
          `${unhonoredSelection.label} context isn't available — ${unhonoredSelection.reason}. ` +
          (usedInstead
            ? `Used ${usedInstead} for this answer instead.`
            : 'Answered without any retrieved context.');
        console.warn(`Explicit context "${contextSelection}" could not be honored: ${unhonoredSelection.reason}`);
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP,
          step: { kind: 'notice', title: notice, status: 'error' },
        });
      }

      // ── Step 2: Build preliminary plan from rule-based result ──────────
      // Search starts immediately with this plan; LLM may refine intent in parallel.
      const prelimPlan = buildPlan(classification);
      console.log(`Preliminary plan: intent=${prelimPlan.intent}, sources=${prelimPlan.sources.join(',')}, topKPerPass=${prelimPlan.topKPerPass}`);

      // ── Step 3: Fan-out search + LLM classification concurrently ───────
      // Codebase turns skip the embedding search pipeline entirely — the model
      // worker gets live tools instead (see generateModelResponse below).
      let finalResults: SearchResult[] = [];

      // Runs whenever there is something to pre-fetch — on a tool turn too. The
      // results ride into the tool prompt as context the model may answer from
      // directly (see the with-context regime in promptTemplates).
      if (prelimPlan.sources.length > 0 && prelimPlan.topKPerPass > 0) {
        const adoQuery = this.rewriteQueryWithUser(message, userDisplayName);
        if (adoQuery !== message) {
          console.log(`ADO query rewritten: "${message}" → "${adoQuery}"`);
        }

        const sourceLabel = prelimPlan.sources
          .map((s) => (s === 'ADO' ? 'Azure DevOps' : 'Confluence'))
          .join(' & ');
        this.postStatus(run, `Searching ${sourceLabel}...`);

        // LLM classification is only worth the latency when:
        // - rule confidence is low AND auto mode
        // - a cloud provider + apiKey are available (skip for local Ollama);
        //   remote mode is always "cloud" — it has no local-model option
        // - BOTH sources are connected (single-source: intent only shifts topK by ±5, not worth it)
        const isCloudProvider =
          mode === 'remote' ||
          (!!(MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === provider)?.BASE_URL || baseUrl) &&
            !!apiKey);
        const needsLLM =
          classification.confidence === 'low' &&
          contextSelection === 'Auto' &&
          isCloudProvider &&
          availableSources.length > 1;

        // Pass 1 search and LLM classification run at the same time
        const [pass1PerSource, upgraded] = await Promise.all([
          Promise.all(
            prelimPlan.sources.map((source) =>
              this.searchSource(source, source === 'ADO' ? adoQuery : message, prelimPlan.topKPerPass)
            )
          ),
          needsLLM
            ? this.classifyIntentWithLLM(run, message, classification, modelId, failoverKeys, provider, availableSources, baseUrl)
            : Promise.resolve({ intent: classification.intent, sources: undefined as DataSource[] | undefined }),
        ]);

        // The LLM used to be able to re-route an ambiguous query to the
        // codebase here, discarding the speculative retrieval. Capability no
        // longer depends on that verdict: tools are already on whenever a
        // folder is open, and the retrieved context rides into the tool
        // prompt, so "this is really a code question" has nothing left to
        // change. The intent upgrade below (topK, second pass) is all it decides.
        {
          // Apply upgraded intent and rebuild the final plan
          if (needsLLM && upgraded.intent !== classification.intent) {
            console.log(`Intent upgraded via LLM: ${classification.intent} → ${upgraded.intent}`);
          }
          classification = { ...classification, intent: upgraded.intent };
          const plan = buildPlan(classification);

          const pass1Flat = pass1PerSource.flat();

          // ── Step 4: Pass 2 (semantic only, when best pass-1 score is weak) ─
          let allResults = pass1Flat;
          if (plan.maxPasses === 2 && pass1Flat.length > 0) {
            const bestScore = Math.max(...pass1Flat.map((r) => r.score));
            if (bestScore < plan.passThreshold) {
              console.log(`Pass 1 best score ${bestScore.toFixed(3)} < ${plan.passThreshold}. Running pass 2.`);
              this.postStatus(run, 'Expanding search...');
              const enrichedQuery = expandQuery(message, pass1Flat);
              const pass2Results = await Promise.all(
                plan.sources.map((source) =>
                  this.searchSource(
                    source,
                    source === 'ADO' ? this.rewriteQueryWithUser(enrichedQuery, userDisplayName) : enrichedQuery,
                    plan.topKPerPass
                  )
                )
              );
              allResults = [...pass1Flat, ...pass2Results.flat()];
            }
          }

          // ── Step 5: Rerank + threshold filter ───────────────────────────
          this.postStatus(run, 'Ranking results...');
          finalResults = rerank(message, allResults, plan);
          console.log(`Reranked to ${finalResults.length} results (threshold=${plan.similarityThreshold}).`);
        }
      }


      // ── Ticket grounding (FETCH stage) ──
      // When the message names a work item and this is a codebase turn, fetch
      // the ticket NOW — code-initiated, before the model runs — so (a) the
      // exploration scout searches the ticket's own vocabulary instead of the
      // prompt's scaffolding, and (b) the prompt carries the acceptance
      // criteria as the definition of done. Failure degrades silently: the
      // model can still call get_ticket itself mid-loop.
      let ticketContext: TicketDetail | null = null;
      const ticketProvider = getActiveTicketProvider(this.context);
      const ticketId = ticketProvider ? detectTicketId(message) : null;
      // Sticky across the session, so a resume record written by a later
      // continuation turn still names the ticket the run is about.
      if (ticketId) run.lastTicketId = ticketId;
      if (ticketId && ticketProvider) {
        const stepId = randomUUID();
        this.postStatus(run, `Reading ticket ${ticketId}...`);
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP,
          id: stepId,
          step: { kind: 'read', title: 'Read ticket', detail: `#${ticketId}`, status: 'running' },
        });
        try {
          ticketContext = await ticketProvider.fetchTicket(ticketId, { includeComments: true });
          mergeRefs(run.turnRefs, refsFromTicket(ticketContext));
          this.post(run, {
            type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
            id: stepId,
            status: 'done',
            summary: ticketContext.state,
          });
          // The run's ticket as a chip ABOVE the collapsed timeline: the user
          // should be able to open what the agent worked from without hunting
          // for it in Azure DevOps. Rides the agent-step channel so it
          // persists with the message and routes to background sessions like
          // every other step ('ticket' is rendered outside the timeline, the
          // same exception 'notice' already uses).
          this.post(run, {
            type: MESSAGE_TYPES.AGENT_STEP,
            step: {
              kind: 'ticket',
              title: `#${ticketContext.id} ${ticketContext.title}`,
              detail: [ticketContext.type, ticketContext.state, ticketContext.assignedTo]
                .filter(Boolean)
                .join(' · '),
              url: ticketContext.url,
              status: 'done',
            },
          });
        } catch (e) {
          console.warn(`Ticket ${ticketId} pre-fetch failed (continuing without):`, e);
          this.post(run, { type: MESSAGE_TYPES.AGENT_STEP_UPDATE, id: stepId, status: 'error', summary: 'failed' });
        }
      }

      // ── Confluence page grounding (FETCH stage) ──
      // Same rationale as ticket grounding above: a pasted Confluence link is
      // fetched NOW, before the model runs. Unlike a ticket, a doc isn't a
      // "definition of done" that drives ship workflow — it's just reference
      // material, so it's threaded in as an eagerly-resolved mention (below)
      // rather than a bespoke prompt-context field. Failure degrades silently:
      // the model can still call get_confluence_page itself mid-loop.
      let confluencePageContext: ConfluencePageDetail | null = null;
      const confluenceAuthenticated = !!settings?.state?.config?.confluence?.isAuthenticated;
      const confluencePageId =
        confluenceAuthenticated ? detectConfluenceUrl(message) : null;
      if (confluencePageId) {
        const stepId = randomUUID();
        this.postStatus(run, `Reading Confluence page ${confluencePageId}...`);
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP,
          id: stepId,
          step: { kind: 'read', title: 'Read Confluence page', detail: `#${confluencePageId}`, status: 'running' },
        });
        try {
          confluencePageContext = await fetchConfluencePage(this.context, confluencePageId);
          this.post(run, {
            type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
            id: stepId,
            status: 'done',
            summary: confluencePageContext.title,
          });
        } catch (e) {
          console.warn(`Confluence page ${confluencePageId} pre-fetch failed (continuing without):`, e);
          this.post(run, { type: MESSAGE_TYPES.AGENT_STEP_UPDATE, id: stepId, status: 'error', summary: 'failed' });
        }
      }

      // What the user actually asked for, and whether retrieval could serve it.
      // Derived signals only — no prompt text or document content is sent.
      // `zeroResults` is the important one: a non-codebase turn that retrieved
      // nothing answers from an empty context, which reads to the user as a bad
      // answer they will rarely report.
      this.analyticsService?.trackEvent('chat_turn', {
        intent: classification.intent,
        sources: classification.sources.join(',') || 'none',
        contextSelection,
        // Chat-mode turns zero out availableSources and retrieve nothing BY
        // REQUEST, so without this the flags below ('hasNoSources',
        // 'zeroResults') would read as "this install cannot do its core job"
        // for users who simply wanted a plain conversation. Split on this
        // before drawing any conclusion from them.
        assistantMode,
        // The user picked a specific context and it wasn't available, so the
        // turn ran against something else. Silent before this was surfaced —
        // and still worth counting, since the fix is a setup step they have
        // to take, not something the notice itself resolves.
        contextSelectionUnhonored: !!unhonoredSelection,
        useCodebaseTools,
        // Whether this turn was the user approving a plan the previous turn
        // proposed — the plan→execute handoff's hit rate in the wild.
        executeMandate,
        // Click-to-run: no human reviews individual steps this turn.
        autonomous,
        // The turn was grounded on a pre-fetched work item (FETCH stage ran).
        ticketGrounded: !!ticketContext,
        // Empty means the extension is running without any queryable source —
        // it cannot do its core job, and nothing else surfaces that state.
        availableSources: availableSources.join(',') || 'none',
        hasNoSources: availableSources.length === 0,
        mode,
        attachmentCount: attachments.length,
        mentionCount: mentions.length,
        resultCount: finalResults.length,
        zeroResults: !useCodebaseTools && finalResults.length === 0,
        bestScore: finalResults.length
          ? Number(Math.max(...finalResults.map((r) => r.score)).toFixed(3))
          : null,
      });

      // ── Step 6: Generate response ──────────────────────────────────────
      // Remote mode resolves the managed endpoint + session token here rather
      // than trusting whatever the webview sent (it has no model picker to
      // send from). One managed model serves every task; the Worker picks it.
      const finalLlm = mode === 'remote' ? getLlmSettings(this.context) : null;
      // Agent runs (autonomous, or grounded in a ticket) may be routed to a
      // stronger model than everyday chat — Settings → Model → "Model for
      // agent runs". Same provider and keys; only the model id differs. The
      // honesty gates in the worker stay as a safety net, but the lever that
      // actually moves ticket-run quality is the model, not more gates.
      const agentModel: string | undefined =
        mode !== 'remote' && (autonomous || ticketContext)
          ? (this.context.globalState.get(STORAGE_KEYS.MODEL) as any)?.state?.selectedModelProvider?.agentModel || undefined
          : undefined;
      const effModelId = finalLlm?.model ?? agentModel ?? modelId;
      const effProvider = finalLlm?.provider ?? provider;
      const effApiKeys = finalLlm?.apiKeys.length ? finalLlm.apiKeys : failoverKeys;
      const effBaseUrl = finalLlm?.baseUrl ?? baseUrl;

      const resolvedMentions = [
        ...(await mentionsPromise),
        // The eagerly pre-fetched Confluence page (if any) rides the same
        // channel as @-mentioned files — it's inline reference material, not
        // prompt-scaffolding the model has to ask for.
        ...(confluencePageContext
          ? [{ name: confluencePageContext.title || confluencePageContext.url, content: confluencePageContext.text }]
          : []),
      ];

      this.postStatus(run, 'Thinking...');
      // Every model call this turn makes differs only in what it asks for —
      // the first attempt, the failure resume below, and the stall resume
      // after it all share the same routing, keys, roots and mandate.
      const callModel = (prompt: string) =>
        this.generateModelResponse(
          run,
          prompt,
          finalResults,
          effModelId,
          effProvider,
          effApiKeys,
          userDisplayName,
          currentSprint,
          useCodebaseTools ? getNamedRoots(workspaceFolders) : undefined,
          effBaseUrl,
          attachments,
          resolvedMentions,
          executeMandate,
          ticketContext,
          autonomous,
          planMode,
          toolAvailability,
          getActiveTicketProvider(this.context)?.label,
          !isWorkMode
        );

      let modelResponse: string;
      try {
        modelResponse = await callModel(message);
      } catch (error) {
        // The run died on infrastructure, not on a decision: a provider
        // outage, a dead socket, the stall net firing. The transcript
        // survived (settle() only clears it for a delivered answer), so a
        // fresh worker can pick up every read and edit already made instead
        // of the user losing the investigation — which is exactly what
        // happened on #1324128, eighteen steps in.
        //
        // One attempt, and only for failures a retry could plausibly beat
        // (see isAutoResumableFailure). If it fails again the error falls
        // through to the handler below, which offers the manual resume.
        // `useCodebaseTools` is part of the condition because only an agent
        // run has a transcript to resume: a plain chat turn that failed while
        // an older agent transcript happened to still be in memory would
        // otherwise be handed a "continue from above" prompt with no above.
        if (!useCodebaseTools || !run.agentTranscript?.length || run.cancelled || !isAutoResumableFailure(error)) {
          throw error;
        }

        const why = error instanceof Error ? error.message : String(error);
        await this.flushResumeSave(run, why);

        // A provider that just told us every endpoint is saturated will say
        // it again a second later. Wait before spending a fresh worker on
        // it; a dead socket or a hung turn needs no such pause.
        const settleWaitMs = isTransientServerError(error) ? PROVIDER_RECOVERY_WAIT_MS : 0;
        if (settleWaitMs) {
          this.postStatus(run, `Provider unavailable — waiting ${Math.round(settleWaitMs / 1000)}s, then resuming where it stopped...`);
          await new Promise((resolve) => setTimeout(resolve, settleWaitMs));
          if (run.cancelled) throw error;
        }

        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP,
          step: {
            kind: 'info',
            title: 'Run interrupted — resuming automatically',
            detail: `${why} · ${run.agentTranscript.length} model message(s) carried over`,
          },
        });
        this.postStatus(run, 'Resuming the interrupted run...');
        modelResponse = await callModel(resumeAfterFailurePrompt(why));
      }

      // Autonomous stall auto-resume (one-shot): a click-to-run ticket turn
      // that ended stall-shaped with zero writes usually means the worker's
      // tool budget ran out mid-task — the honesty gates are skipped by
      // design at that point, and no human is present to type "continue".
      // The stall answer kept run.agentTranscript (see settle()), so a second
      // generateModelResponse resumes with every read carried over AND a
      // fresh worker, i.e. a fresh tool budget — exactly what exhaustion
      // needs. One attempt only: if the resumed run still stalls, deliver
      // what we have rather than looping.
      if (
        run.autonomous &&
        ticketContext &&
        run.lastAnswerStallShaped &&
        run.agentTranscript?.length &&
        !run.cancelled
      ) {
        run.chatHistory.push({ role: 'assistant', content: modelResponse });
        // The report just streamed is SUPERSEDED by the one this second
        // segment will produce, so clear the bubble rather than appending to
        // it. Without this both reports end up in one message and the stale
        // heading is the visible one — #1384667 was stored as a single answer
        // reading "0 edits applied · step limit reached" above a second report
        // that listed the two files the run went on to change. The chat
        // history entry above is deliberately kept: the MODEL still needs its
        // own previous answer as context for the continuation.
        this.post(run, { type: MESSAGE_TYPES.RECEIVE_MESSAGE_RESTART });
        this.postStatus(run, 'Run ended without finishing — resuming with a fresh tool budget...');
        modelResponse = await callModel(
          'Continue the ticket run from where the previous turn stopped — the investigation so far is carried over above. ' +
            'Finish it now: apply the fix with your edit tools, or end with a "## Blocked" / "## No change needed" section. Do not re-investigate what is already read. ' +
            'If the transcript above shows the fix already applied AND verified, do not redo or re-verify it — deliver the final report. ' +
            // This resume exists BECAUSE the previous segment ended without
            // writing, and on #1534774 it did that by calling a step-limit
            // stop a blocker. Say plainly what that answer got wrong, or the
            // second segment reproduces it with a fresh budget.
            'The previous segment ran out of steps rather than out of options: that is not a blocker, and neither is a decision you could settle with a reasonable default. ' +
            'Reserve "## Blocked" for a conflict you can QUOTE from the ticket. Anything else means: pick the default, apply the edit, and record the default under Assumptions.'
        );
      }

      run.chatHistory.push({ role: 'assistant', content: modelResponse });
      // Arm "Create PR" for this turn when it changed files: the report is the
      // PR body and the ticket comment, the ticket title the commit subject.
      run.lastShip =
        run.turnFilesChanged.size > 0
          ? {
              ticketId: ticketContext?.id,
              ticketType: ticketContext?.type,
              title: deriveShipTitle(ticketContext?.title, modelResponse),
              report: modelResponse,
              files: [...run.turnFilesChanged.keys()],
              hasNewFiles: [...run.turnFilesChanged.values()].some((f) => f.kind === 'create'),
            }
          : null;
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      if (error instanceof Error && error.message === 'Generation cancelled by user.') {
        console.log('Chat generation cancelled by user.');
        // A stopped run is the one users are most likely to continue, so park
        // it on disk too rather than leaving it only in this process.
        void this.flushResumeSave(run, 'You stopped the run.');
        return;
      }
      console.error('Error in chat:', error);
      // The transcript outlives a failed turn (settle() clears it only for a
      // delivered answer), and the whole point of keeping it is that the next
      // message can resume from it. That was invisible: the user saw
      // "Service temporarily unavailable" and had no reason to think eighteen
      // steps of work were still being held. Report it as DATA rather than as
      // a sentence in the error prose, so the card can carry a Resume button
      // instead of asking the user to guess the right words.
      const held = run.agentTranscript?.length ?? 0;
      if (held) void this.flushResumeSave(run, why);
      this.post(run, {
        type: MESSAGE_TYPES.ERROR_CHAT,
        message: why,
        ...(held ? { resumable: { steps: held, writesApplied: run.sessionWritesApplied } } : {}),
      });
    }
  }

  /**
   * Routes a search request to the correct embedding service.
   */
  private async searchSource(
    source: DataSource,
    query: string,
    topK: number
  ): Promise<SearchResult[]> {
    if (source === 'CONFLUENCE') {
      return this.embeddingService.searchEmbeddings(query, topK);
    }
    if (source === 'CODEBASE') {
      // Codebase never reaches the embedding pipeline — sendMessage() routes
      // it to the live tool-calling loop instead (see useCodebaseTools).
      return [];
    }
    if (source === 'JIRA') {
      return this.jiraEmbeddingService.searchEmbeddings(query, topK);
    }
    return this.adoEmbeddingService.searchEmbeddings(query, topK);
  }

  /**
   * Dispatches a tool call requested by the model worker to the corresponding
   * codebase tool function. Called from the modelWorker 'message' handler in
   * generateModelResponse() when it receives a `tool_request`.
   */
  private async executeCodebaseTool(
    run: SessionRun,
    name: string,
    args: any,
    roots: NamedRoot[],
    stepId?: string
  ): Promise<unknown> {
    switch (name) {
      case 'search_codebase':
        return searchCodebase(args, roots);
      case 'read_file':
        return readFile(args, roots);
      case 'list_directory':
        return listDirectory(args, roots);
      case 'find_files':
        return findFiles(args, roots);
      case 'find_symbol':
        return findSymbol(args, roots);
      case 'find_references':
        return findReferences(args, roots);
      case 'go_to_definition':
        return goToDefinition(args, roots);
      case 'edit_file':
        return this.gatedWrite(run, await prepareEditFile(args, roots), roots);
      case 'create_file':
        return this.gatedWrite(run, await prepareCreateFile(args, roots), roots);
      case 'delete_file':
        return this.gatedWrite(run, await prepareDeleteFile(args, roots), roots);
      case 'get_diagnostics':
        return getDiagnostics(args, roots);
      case 'git_status':
        return gitStatus(args, roots);
      case 'git_diff':
        return gitDiff(args, roots);
      case 'git_log':
        return gitLog(args, roots);
      case 'git_blame':
        return gitBlame(args, roots);
      case 'run_command':
        return this.gatedCommand(run, args, roots, stepId);
      case 'run_checks':
        return this.runChecks(run, args, roots, stepId);
      case 'search_docs':
        return this.searchKnowledge('CONFLUENCE', args);
      case 'search_tickets':
        // Whichever tracker is active owns the index namespace to search —
        // same registry lookup get_ticket below uses, so the two tools never
        // disagree about which tracker is "the" one.
        return this.searchKnowledge(getActiveTicketProvider(this.context)?.kind === 'jira' ? 'JIRA' : 'ADO', args);
      case 'get_ticket': {
        const provider = getActiveTicketProvider(this.context);
        if (!provider) throw new Error('No ticket tracker is connected. Connect one in Settings.');
        return provider.fetchTicket(String(args?.id ?? ''), { includeComments: !!args?.includeComments });
      }
      case 'get_confluence_page':
        return fetchConfluencePage(this.context, args?.pageId ?? '');
      case 'search_web':
        return searchWeb(this.context, args, (message) => this.postStatus(run, message));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * run_command flow: denylist (hard block) → session allowlist (skip the
   * card) → approval card → checkpoint → execute → mirror output + audit.
   */
  /**
   * Live tail of a running command into its timeline row (status stays
   * 'running'; meta.output grows). Throttled so a chatty test runner doesn't
   * flood the webview.
   */
  private streamOutputTo(run: SessionRun, stepId: string | undefined): ((combined: string) => void) | undefined {
    if (!stepId) return undefined;
    let last = 0;
    return (combined: string) => {
      const now = Date.now();
      if (now - last < 700) return;
      last = now;
      this.post(run, {
        type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
        id: stepId,
        status: 'running',
        meta: { output: combined.slice(-4000) },
      });
    };
  }

  /**
   * The executable a shell command invokes — its first bare word, so
   * `pnpm exec jest src/x.test.ts` is `pnpm`. Enough to answer "did we
   * already learn this one is not installed", which is all it is for.
   */
  private static commandExecutable(command: string): string {
    return (command.trim().split(/\s+/)[0] ?? '').trim();
  }

  /**
   * Exit 127 is the shell's "command not found", and it is deterministic: the
   * binary will not appear because we asked a second time. Remember it so the
   * next call short-circuits, and say plainly that this is the environment
   * rather than the code — a run told only "exit 127" tries `npx`, then
   * `yarn`, then reports the workspace as broken.
   */
  private noteExecutableMissing(run: SessionRun, command: string, res: CommandResult): void {
    if (res.exitCode !== 127) return;
    const exe = ChatService.commandExecutable(command);
    if (!exe || run.missingExecutables.has(exe)) return;
    run.missingExecutables.set(exe, (res.output || '').trim().slice(0, 400));
  }

  /**
   * The remembered 127 for this command, as a result the caller can return
   * without spawning anything. Null when this executable has not failed that
   * way in this turn.
   */
  private replayMissingExecutable(run: SessionRun, command: string): CommandResult | null {
    const exe = ChatService.commandExecutable(command);
    const seen = exe ? run.missingExecutables.get(exe) : undefined;
    if (seen === undefined) return null;
    return {
      exitCode: 127,
      output:
        `${seen}\n\n[not run — "${exe}" already exited 127 (command not found) earlier this turn. ` +
        'That is this machine\'s PATH, not the code and not the workspace: retrying it, or the same ' +
        'command through a different package manager, will fail identically. Verify what you can with ' +
        'get_diagnostics, and in your final answer report the affected checks as NOT RUN with this ' +
        'reason — do not claim they passed, and do not spend further steps on them.]',
      durationMs: 0,
      truncated: false,
      timedOut: false,
    };
  }

  /**
   * run_checks: derive the verification command for a file (see verifyTools),
   * run it, remember it on success. Autonomous-safe by construction — the
   * command is test/lint/typecheck for the file's own package.
   */
  private async runChecks(run: SessionRun, args: RunChecksArgs, roots: NamedRoot[], stepId?: string): Promise<unknown> {
    const plan = planVerification(roots, args);
    assertCommandAllowed(plan.command);
    // Same command, same tree → same result. Replay it instead of re-running:
    // a package-wide suite derived for three changed files in one package is
    // one run, not three, and a model that re-runs the suite to "double check"
    // gets the answer back instantly with the reason why.
    const cacheKey = `${plan.cwd}::${plan.command}`;
    const cached = run.checkRuns.get(cacheKey);
    if (cached && cached.writeSeq === run.writeSeq) {
      if (stepId) {
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
          id: stepId,
          status: 'running',
          summary: `in ${plan.displayCwd}`,
          meta: { output: `$ ${plan.command}\n(replayed — already ran this turn, no write since)\n` },
        });
      }
      return {
        ...(cached.result as Record<string, unknown>),
        cached: true,
        note: 'This exact command already ran this turn and no write has landed since — the result above is that run, not a new one. Do not run it again unless you change a file first.',
      };
    }
    // Already running — join it rather than starting a second copy.
    const inFlight = run.checkInFlight.get(cacheKey);
    if (inFlight) {
      if (stepId) {
        this.post(run, {
          type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
          id: stepId,
          status: 'running',
          summary: `in ${plan.displayCwd}`,
          meta: { output: `$ ${plan.command}\n(joined — this exact command is already running for another file)\n` },
        });
      }
      const shared = (await inFlight) as Record<string, unknown>;
      // coveredPaths belongs to the call that STARTED the command, not to
      // this one — carrying it over would mark this caller's files verified
      // by an argv that never named them.
      const { coveredPaths: _shared, ...rest } = shared ?? {};
      return { ...rest, ...(plan.coveredPaths ? { coveredPaths: plan.coveredPaths } : {}), cached: true };
    }
    this.postStatus(run, `Running ${plan.kind}: ${plan.command}`);
    if (stepId) {
      this.post(run, { type: MESSAGE_TYPES.AGENT_STEP_UPDATE, id: stepId, status: 'running', summary: `in ${plan.displayCwd}`, meta: { output: `$ ${plan.command}\n` } });
    }
    const execution = (async () => {
      const res =
        this.replayMissingExecutable(run, plan.command) ??
        (await executeCommand(plan.command, plan.cwd, undefined, this.streamOutputTo(run, stepId), true));
      this.noteExecutableMissing(run, plan.command, res);
      const channel = agentOutputChannel();
      channel.appendLine(`\n$ ${plan.command}   (cwd: ${plan.displayCwd}, exit ${res.exitCode}, ${res.durationMs}ms) — run_checks ${plan.kind}`);
      if (res.output) channel.appendLine(res.output);
      await this.audit('command', `${plan.command} → exit ${res.exitCode}`, 'auto', res.exitCode === 0 ? 'applied' : 'failed');
      if (res.exitCode === 0) void rememberRecipe(this.context, plan);
      const result = {
        kind: plan.kind,
        command: plan.command,
        cwd: plan.displayCwd,
        package: plan.pkgName,
        rationale: plan.rationale,
        // Which of the caller's paths this one process actually covered — the
        // auto-verification pass marks exactly these done (see planCheckJobs).
        ...(plan.coveredPaths ? { coveredPaths: plan.coveredPaths } : {}),
        ...res,
        ...(res.exitCode !== 0 && !res.timedOut
          ? { hint: 'Non-zero exit: read the output above and fix the cause (a failing assertion, a lint error, a missing import). Do not switch to run_command to "try another way" unless the output says the runner itself could not start.' }
          : {}),
      };
      run.checkRuns.set(cacheKey, { writeSeq: run.writeSeq, result });
      return result;
    })();
    run.checkInFlight.set(cacheKey, execution);
    try {
      return await execution;
    } finally {
      run.checkInFlight.delete(cacheKey);
    }
  }

  private async gatedCommand(run: SessionRun, args: RunCommandArgs, roots: NamedRoot[], stepId?: string): Promise<unknown> {
    const command = (args.command ?? '').trim();
    if (!command) throw new Error('command must be non-empty.');
    assertCommandAllowed(command);
    const { cwd, displayCwd } = resolveCommandCwd(roots, args.cwd);
    // Ahead of the approval gate and the checkpoint on purpose: a command we
    // have already watched exit 127 must not cost the user a review card or
    // the run a snapshot.
    const missing = this.replayMissingExecutable(run, command);
    if (missing) return missing;
    // A repo-wide `pnpm lint`/`pnpm test` at the workspace root checks every
    // package to verify a change that touched a few files — minutes of wall
    // clock in a monorepo, and auto-approved (so invisible) in an autonomous
    // run. run_checks already derives the scoped command; this is what makes
    // a run actually use it. Lifted when the user asked for a wide run.
    const unscoped = checkUnscopedVerification({
      command,
      cwd,
      rootPaths: roots.map((r) => r.uri.fsPath),
      userAskedRepoWide: run.userAskedRepoWide,
    });
    if (unscoped) {
      await this.audit('command', command, 'rejected', 'skipped', unscoped.reason);
      throw new Error(unscoped.reason);
    }
    const summary = `Run: ${command}`;

    let decisionKind: 'auto' | 'approved' | 'approved-session' = 'auto';
    if (run.autonomous) {
      // No one is present to review a command card — so only verification
      // commands run at all, and they run without a card. Anything else is
      // refused with guidance the model can act on (report it, don't retry).
      if (!isAutonomousSafeCommand(command)) {
        await this.audit('command', command, 'rejected', 'skipped');
        throw new Error(describeAutonomousRefusal(command));
      }
    } else if (!this.sessionCommandAllowlist.has(command)) {
      const { id, decision } = run.writeGate.await({ kind: 'command', summary });
      this.post(run, {
        type: MESSAGE_TYPES.AGENT_WRITE_REVIEW,
        id,
        kind: 'command',
        path: displayCwd,
        summary,
        command,
        diff: { added: 0, removed: 0, text: '' },
      });
      const result = await decision;
      if (!result.approved) {
        await this.audit('command', command, 'rejected', 'skipped');
        throw new Error(
          `The user rejected running this command.${result.feedback ? ` Feedback: ${result.feedback}` : ''} ` +
            'Do not retry it verbatim — adjust per the feedback or proceed without it.'
        );
      }
      if (result.scope === 'session') {
        this.sessionCommandAllowlist.add(command);
        decisionKind = 'approved-session';
      } else {
        decisionKind = 'approved';
      }
    }

    this.postStatus(run, `Running: ${command}`);
    // Autonomous runs auto-approve verification commands, so nobody is there
    // to notice one that runs long — those get the unattended ceiling.
    const res = await executeCommand(command, cwd, args.timeoutSec, this.streamOutputTo(run, stepId), run.autonomous);
    this.noteExecutableMissing(run, command, res);
    const channel = agentOutputChannel();
    channel.appendLine(`\n$ ${command}   (cwd: ${displayCwd}, exit ${res.exitCode}, ${res.durationMs}ms)`);
    if (res.output) channel.appendLine(res.output);
    await this.audit('command', `${command} → exit ${res.exitCode}`, decisionKind, res.exitCode === 0 ? 'applied' : 'failed');
    return res;
  }

  /** Append one line to the agent-actions JSONL audit log; never throws. */
  private async audit(
    action: 'edit' | 'create' | 'delete' | 'command',
    detail: string,
    decision: 'approved' | 'approved-session' | 'rejected' | 'auto',
    outcome: 'applied' | 'failed' | 'skipped',
    error?: string
  ): Promise<void> {
    try {
      await recordAgentAudit(this.context.globalStorageUri.fsPath, {
        ts: new Date().toISOString(),
        action,
        detail,
        decision,
        outcome,
        error,
      });
    } catch (e) {
      console.warn('WorkspaceGPT: audit write failed:', e);
    }
  }

  /**
   * Org-knowledge tools for the agent loop (P3.1): the same Confluence/ADO
   * semantic search that powers RAG chat, exposed as tools so the agent can
   * pull design docs and tickets MID-TASK ("implement D2C-1234" → read the
   * ticket → find the design page → then touch code). Results are compacted —
   * the worker caps tool output, so send only what the model needs.
   */
  private async searchKnowledge(
    source: DataSource,
    args: { query: string; topK?: number }
  ): Promise<unknown> {
    if (!args?.query?.trim()) throw new Error('query must be non-empty.');
    const topK = Math.min(Math.max(args.topK ?? 5, 1), 10);
    // The sync-state section this source's index lives under, and the live
    // per-id tool that beats a possibly-stale search hit — three-way rather
    // than the CONFLUENCE/else binary this was before Jira, since "else" no
    // longer means only ADO.
    const syncSection: SyncSection = source === 'CONFLUENCE' ? 'confluence' : source === 'JIRA' ? 'jira' : 'ado';
    const liveTool = source === 'CONFLUENCE' ? 'get_confluence_page' : 'get_ticket';

    let results: SearchResult[];
    try {
      results = await this.searchSource(source, args.query, topK);
    } catch (e) {
      throw new Error(
        `${SOURCE_LABELS[source]} search unavailable: ${e instanceof Error ? e.message : String(e)}. ` +
          'The source may not be connected/synced — answer from the codebase alone or tell the user.'
      );
    }
    // Every hit here comes from a local snapshot, so the snapshot's age is part
    // of the answer: anything created or edited since is simply not searchable,
    // and zero hits for it means nothing (#1536998 — a design doc written the
    // day of the run, against an index a week old).
    const lastSync = readLastSyncTime(this.context, syncSection);
    const staleNote = lastSync
      ? `This index was last synced ${lastSync.slice(0, 10)} — anything created or edited after that date is NOT in it. ` +
        `For a page or ticket you can name (a URL or id in the ticket, or one the user gave), fetch it live with ${liveTool} instead of relying on these results.`
      : `This index's last sync time is unknown — it may predate recent pages. Fetch anything you can name by URL or id with ${liveTool}.`;
    return {
      indexedThrough: lastSync ?? 'unknown',
      note: staleNote,
      results: results.map((r) => ({
        source: r.data?.source,
        title: (r.data as any)?.title ?? (r.data as any)?.name,
        url: (r.data as any)?.url,
        text: r.text.length > 1500 ? r.text.slice(0, 1500) + '… (truncated)' : r.text,
      })),
    };
  }

  /**
   * The write half of the agent loop: show the prepared write to the user as
   * a diff card, block until they decide (the worker's tool loop is already
   * parked on this promise), checkpoint, then apply. A rejection surfaces to
   * the model as a tool error carrying the user's feedback.
   */
  private async gatedWrite(run: SessionRun, write: PreparedWrite, roots: NamedRoot[]): Promise<unknown> {
    const diff = buildReviewDiff(write.before, write.after);
    // Autonomous runs skip the review card — nobody is present to click it, and
    // a parked gate would hang the run. The change is still checkpointed below
    // (revertible per turn), recorded in the files-changed bar with a Review
    // diff, and audited with decision 'auto'.
    const decisionKind: 'auto' | 'approved' = run.autonomous ? 'auto' : 'approved';
    if (!run.autonomous) {
      const { id, decision } = run.writeGate.await(write);
      this.post(run, {
        type: MESSAGE_TYPES.AGENT_WRITE_REVIEW,
        id,
        kind: write.kind,
        path: write.displayPath,
        summary: write.summary,
        diff,
      });

      const result = await decision;
      if (!result.approved) {
        await this.audit(write.kind, write.summary, 'rejected', 'skipped');
        throw new Error(
          `The user rejected this ${write.kind}.${result.feedback ? ` Feedback: ${result.feedback}` : ''} ` +
            'Do not retry the same change — adjust per the feedback or ask the user how to proceed.'
        );
      }
    }

    // Snapshot BEFORE mutating, so "revert this step" is always available.
    try {
      const root = roots.find((candidate) =>
        write.uri.fsPath === candidate.uri.fsPath || write.uri.fsPath.startsWith(candidate.uri.fsPath + path.sep)
      );
      if (!root) throw new Error(`Cannot checkpoint ${write.displayPath}: it is not inside an open workspace root.`);
      const relativePath = path.relative(root.uri.fsPath, write.uri.fsPath);
      const cp = this.checkpointsFor(root).checkpoint(
        write.summary,
        [relativePath],
        write.kind === 'create',
      );
      const checkpoint = await cp;
      this.checkpointRootsBySha.set(checkpoint.sha, root.uri.fsPath);
      if (!run.turnFirstCheckpointSha) run.turnFirstCheckpointSha = checkpoint.sha;
    } catch (e) {
      console.warn('WorkspaceGPT: checkpoint failed (continuing with the write):', e);
    }
    // Remember the pre-agent content (first touch wins) so the files-changed
    // bar's Review action can open a native original ⟷ current diff.
    recordOriginalContent(write.uri.fsPath, write.before);
    try {
      await applyWrite(write);
    } catch (e) {
      await this.audit(write.kind, write.summary, decisionKind, 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
    // A create's pre-write checkpoint is intentionally empty: the target did
    // not exist yet. Commit the newly created file afterwards so resetting to
    // that pre-write checkpoint removes it again.
    if (write.kind === 'create') {
      try {
        const root = roots.find((candidate) =>
          write.uri.fsPath === candidate.uri.fsPath || write.uri.fsPath.startsWith(candidate.uri.fsPath + path.sep)
        );
        if (root) {
          await this.checkpointsFor(root).checkpoint(
            `Track created file: ${write.displayPath}`,
            [path.relative(root.uri.fsPath, write.uri.fsPath)],
          );
        }
      } catch (e) {
        console.warn('WorkspaceGPT: could not track newly created file in checkpoint history:', e);
      }
    }
    await this.audit(write.kind, write.summary, decisionKind, 'applied');
    if (write.kind !== 'delete') await this.formatIfConfigured(write.uri);
    run.writeSeq++;
    run.sessionWritesApplied++;
    const prior = run.turnFilesChanged.get(write.displayPath);
    run.turnFilesChanged.set(write.displayPath, {
      path: write.displayPath,
      kind: write.kind,
      added: (prior?.added ?? 0) + diff.added,
      removed: (prior?.removed ?? 0) + diff.removed,
    });
    return { applied: true, path: write.displayPath, summary: write.summary, added: diff.added, removed: diff.removed };
  }

  /**
   * Mirror the editor's own save behavior on agent writes: when the user has
   * `editor.formatOnSave` for this file's language, run the configured
   * formatter (Prettier, etc.) and save — programmatic saves bypass the
   * editor's hook, which is why an agent edit would otherwise arrive
   * unformatted and cost a lint-fix round. Silent no-op without a formatter;
   * bounded so a slow-to-start formatter extension never stalls a run.
   */
  private async formatIfConfigured(uri: vscode.Uri): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editorCfg = vscode.workspace.getConfiguration('editor', { uri, languageId: doc.languageId });
      if (!editorCfg.get<boolean>('formatOnSave')) return;
      const edits = await Promise.race<vscode.TextEdit[] | undefined>([
        vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', uri, {
          tabSize: editorCfg.get<number>('tabSize', 2),
          insertSpaces: editorCfg.get<boolean>('insertSpaces', true),
        }),
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000)),
      ]);
      if (!edits?.length) return;
      const we = new vscode.WorkspaceEdit();
      we.set(uri, edits);
      if (await vscode.workspace.applyEdit(we)) await doc.save();
    } catch (e) {
      console.warn('WorkspaceGPT: post-write format skipped:', e instanceof Error ? e.message : e);
    }
  }

  /**
   * "Create PR" from the files-changed bar: branch, commit the turn's files,
   * push, open the PR page, post the report on the ticket. Progress rides the
   * status line; the outcome goes back correlated by requestId.
   */
  public async shipTurn(sessionId: string, requestId?: string, clientShipInput?: ShipInput): Promise<void> {
    const run = this.runs.get(sessionId);
    const reply = (payload: Record<string, unknown>) =>
      this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.AGENT_SHIP_DONE, sessionId, requestId, ...payload });
    // Prefer the host's own in-memory record when this is the same live run;
    // fall back to what the webview sent (from its persisted transcript) when
    // it isn't — e.g. after an extension host restart wiped `run.lastShip`.
    const shipInput = run?.lastShip ?? (clientShipInput?.files?.length ? clientShipInput : null);
    if (!shipInput) {
      reply({ ok: false, error: 'Nothing to ship — no agent changes are recorded for this chat.' });
      return;
    }
    const roots = getNamedRoots(vscode.workspace.workspaceFolders ?? []);
    try {
      const result = await shipChanges(this.context, roots, shipInput, (text) => (run ? this.postStatus(run, text) : undefined));
      if (run) this.postStatus(run, '');
      const summary =
        `Branch ${result.branch} pushed` +
        (result.prUrl ? ' — pull-request page opened' : '') +
        (result.ticketCommented ? ` — report posted on #${shipInput.ticketId}` : '');
      if (run) {
        this.post(run, { type: MESSAGE_TYPES.AGENT_STEP, step: { kind: 'notice', title: summary, status: 'done' } });
        for (const w of result.warnings) {
          this.post(run, { type: MESSAGE_TYPES.AGENT_STEP, step: { kind: 'notice', title: w, status: 'error' } });
        }
        run.lastShip = null;
      }
      reply({ ok: true, branch: result.branch, prUrl: result.prUrl, ticketCommented: result.ticketCommented, warnings: result.warnings });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (run) {
        this.postStatus(run, '');
        this.post(run, { type: MESSAGE_TYPES.AGENT_STEP, step: { kind: 'notice', title: `Create PR failed: ${message}`, status: 'error' } });
      }
      reply({ ok: false, error: message });
    }
  }

  /** Lazily construct the per-workspace shadow-git checkpoint service. */
  private checkpoints(roots: NamedRoot[]): CheckpointService {
    return this.checkpointsFor(roots[0]);
  }

  private checkpointsFor(root: NamedRoot): CheckpointService {
    let service = this.checkpointServices.get(root.uri.fsPath);
    if (!service) {
      service = checkpointServiceFor(this.context.globalStorageUri.fsPath, root.uri.fsPath);
      this.checkpointServices.set(root.uri.fsPath, service);
    }
    return service;
  }

  /** Per-message "Undo changes up to this point" — hard-resets to a turn's first checkpoint. */
  public async revertToCheckpoint(sha: string): Promise<void> {
    const roots = getNamedRoots(vscode.workspace.workspaceFolders ?? []);
    if (!roots.length) throw new Error('No workspace folder is open.');
    const rootPath = this.checkpointRootsBySha.get(sha);
    const root = roots.find((candidate) => candidate.uri.fsPath === rootPath) ?? roots[0];
    await this.checkpointsFor(root).revertTo(sha);
  }

  /** Webview AGENT_WRITE_DECISION handler — resolves the parked write gate. */
  public resolveAgentWrite(id: string, approved: boolean, feedback?: string, scope?: 'once' | 'session'): void {
    // Gate ids are globally unique — find the session whose gate parked it.
    for (const run of this.runs.values()) {
      if (run.writeGate.resolve(id, approved, feedback, scope)) return;
    }
  }

  /**
   * Structured step descriptor for a starting tool call — the persistent
   * timeline entry ("Analyzed LeadsView.tsx #L150-250"), unlike the transient
   * describeToolCall() label below.
   */
  private describeToolStart(name: string, args: any): AgentStepStart {
    switch (name) {
      case 'search_codebase':
        return { kind: 'search', title: 'Searched', detail: args?.query ?? '' };
      case 'find_files':
        return { kind: 'search', title: 'Globbed', detail: args?.pattern ?? '' };
      case 'find_symbol':
        return { kind: 'search', title: 'Looked up', detail: args?.query ?? '' };
      case 'find_references':
        return { kind: 'search', title: 'Found references to', detail: args?.symbol ?? '' };
      case 'go_to_definition':
        return { kind: 'search', title: 'Went to definition of', detail: args?.symbol ?? '' };
      case 'search_docs':
        return { kind: 'search', title: 'Searched Confluence', detail: args?.query ?? '' };
      case 'search_tickets':
        return {
          kind: 'search',
          title: `Searched ${getActiveTicketProvider(this.context)?.label ?? 'Azure DevOps'}`,
          detail: args?.query ?? '',
        };
      case 'get_ticket':
        return { kind: 'read', title: 'Read ticket', detail: String(args?.id ?? '') };
      case 'get_confluence_page':
        return { kind: 'read', title: 'Read Confluence page', detail: String(args?.pageId ?? '') };
      case 'search_web':
        return { kind: 'search', title: 'Searched the web', detail: args?.query ?? '' };
      case 'explore':
        return { kind: 'search', title: 'Investigated', detail: String(args?.question ?? '').slice(0, 90) };
      case 'read_file': {
        const range = args?.startLine
          ? `#L${args.startLine}${args?.endLine ? `-${args.endLine}` : ''}`
          : undefined;
        return { kind: 'read', title: 'Analyzed', path: args?.path, detail: range };
      }
      case 'list_directory':
        return { kind: 'read', title: 'Explored', path: args?.path || '.' };
      case 'get_diagnostics':
        return { kind: 'check', title: 'Checked problems', path: args?.path };
      case 'git_status':
        return { kind: 'read', title: 'Read git status' };
      case 'git_diff':
        return { kind: 'read', title: 'Read git diff', path: args?.path };
      case 'git_log':
        return { kind: 'read', title: 'Read git history', path: args?.path };
      case 'git_blame':
        return { kind: 'read', title: 'Read git blame', path: args?.path };
      case 'edit_file':
        return { kind: 'edit', title: 'Edited', path: args?.path };
      case 'create_file':
        return { kind: 'edit', title: 'Created', path: args?.path };
      case 'delete_file':
        return { kind: 'edit', title: 'Deleted', path: args?.path };
      case 'run_command':
        // The model's own 3-6 word label is the row title; the raw command
        // moves behind the row's toggle. Three consecutive rows reading
        // "pnpm --filter @phoenix/mms-webapp exec jest src/api/features/Chec…"
        // were indistinguishable from each other (observed live).
        return {
          kind: 'command',
          title: (args?.description ?? '').trim() || 'Ran',
          detail: args?.command ?? '',
        };
      case 'run_checks':
        return { kind: 'command', title: `Ran ${args?.kind ?? 'test'}s for`, detail: String(args?.path ?? '').split('/').pop() ?? '' };
      default:
        return { kind: 'info', title: name };
    }
  }

  /**
   * One-phrase completion summary for a finished step ("28 results", "+2 −2",
   * "exit 0"), plus optional meta the UI renders inline (command output tail).
   */
  private summarizeToolResult(
    name: string,
    result: any
  ): { summary?: string; meta?: Record<string, unknown> } {
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    switch (name) {
      case 'search_codebase': {
        const n = result?.totalMatches ?? result?.matches?.length ?? result?.files?.length ?? 0;
        // "0 results" on a capped fallback scan reads in the timeline exactly
        // like "this workspace does not contain that" — the false negative
        // behind #1536998's early searches. Say which one the user is seeing.
        return { summary: result?.partial ? `${plural(n, 'result')} · partial scan` : plural(n, 'result') };
      }
      case 'find_files':
        return { summary: plural(result?.files?.length ?? 0, 'file') };
      case 'find_symbol':
        return { summary: plural(result?.symbols?.length ?? 0, 'match', 'matches') };
      case 'find_references':
        return { summary: plural(result?.references?.length ?? result?.locations?.length ?? 0, 'reference') };
      case 'read_file':
        return result?.totalLines ? { summary: `${result.totalLines} lines` } : {};
      case 'list_directory':
        return { summary: plural(result?.entries?.length ?? 0, 'entry', 'entries') };
      case 'get_diagnostics': {
        const total = result?.totalProblems ?? 0;
        if (total === 0) return { summary: 'no problems' };
        const errors = (result?.diagnostics ?? []).filter((d: any) => d?.severity === 'error').length;
        return { summary: errors > 0 ? `${plural(errors, 'error')} · ${total} total` : plural(total, 'problem') };
      }
      case 'run_command':
      case 'run_checks':
        return {
          summary: result?.timedOut
            ? 'timed out'
            : `exit ${result?.exitCode ?? '?'}${result?.cached ? ' · replayed' : ''}`,
          meta: {
            exitCode: result?.exitCode ?? null,
            durationMs: result?.durationMs,
            output:
              (name === 'run_checks' && result?.command ? `$ ${result.command}   (in ${result.cwd})\n` : '') +
              (typeof result?.output === 'string' ? result.output.slice(0, 4000) : ''),
          },
        };
      case 'edit_file':
      case 'create_file':
      case 'delete_file':
        return result?.applied ? { summary: `+${result.added ?? 0} −${result.removed ?? 0}` } : {};
      case 'search_docs':
      case 'search_tickets':
        return { summary: plural(result?.results?.length ?? 0, 'result') };
      case 'search_web': {
        const count = plural(result?.results?.length ?? 0, 'result');
        return { summary: result?.provider === 'duckduckgo-basic' ? `(basic search) ${count}` : count };
      }
      case 'get_ticket':
        // The state is the useful at-a-glance fact ("Active", "Resolved").
        return result?.state ? { summary: String(result.state) } : {};
      case 'get_confluence_page':
        return result?.title ? { summary: String(result.title) } : {};
      default:
        return {};
    }
  }

  /** Human-readable status text for a codebase tool call, shown in the loading indicator. */
  private describeToolCall(name: string, args: any): string {
    switch (name) {
      case 'search_codebase':
        return `Searching codebase for "${args?.query ?? ''}"...`;
      case 'explore':
        return `Investigating: ${String(args?.question ?? '').slice(0, 60)}...`;
      case 'read_file':
        return `Reading ${args?.path ?? 'file'}...`;
      case 'list_directory':
        return `Listing ${args?.path || 'workspace root'}...`;
      case 'find_files':
        return `Finding files matching "${args?.pattern ?? ''}"...`;
      case 'find_symbol':
        return `Looking up symbol "${args?.query ?? ''}"...`;
      case 'find_references':
        return `Finding references to "${args?.symbol ?? ''}"...`;
      case 'go_to_definition':
        return `Finding definition of "${args?.symbol ?? ''}"...`;
      case 'run_command':
        return `Proposing command: ${args?.command ?? ''} (awaiting your review)...`;
      case 'run_checks':
        return `Running ${args?.kind ?? 'test'} checks for ${String(args?.path ?? '').split('/').pop()}...`;
      case 'search_docs':
        return `Searching Confluence for "${args?.query ?? ''}"...`;
      case 'search_tickets':
        return `Searching ${getActiveTicketProvider(this.context)?.label ?? 'Azure DevOps'} for "${args?.query ?? ''}"...`;
      case 'get_ticket':
        return `Reading ticket ${args?.id ?? ''}...`;
      case 'get_confluence_page':
        return `Reading Confluence page ${args?.pageId ?? ''}...`;
      case 'search_web':
        return `Searching the web for "${args?.query ?? ''}"...`;
      case 'get_diagnostics':
        return args?.path ? `Checking problems in ${args.path}...` : 'Checking workspace problems...';
      case 'git_status':
        return 'Reading git status...';
      case 'git_diff':
        return `Reading git diff${args?.path ? ` for ${args.path}` : ''}...`;
      case 'git_log':
        return `Reading git history${args?.path ? ` for ${args.path}` : ''}...`;
      case 'git_blame':
        return `Reading git blame for ${args?.path ?? 'file'}...`;
      case 'edit_file':
        return `Proposing edit to ${args?.path ?? 'file'} (awaiting your review)...`;
      case 'create_file':
        return `Proposing new file ${args?.path ?? ''} (awaiting your review)...`;
      case 'delete_file':
        return `Proposing deletion of ${args?.path ?? 'file'} (awaiting your review)...`;
      default:
        return 'Working...';
    }
  }

  private formatSearchResults(results: SearchResult[]): string {
    if (!results.length) {
      return 'No relevant information found.';
    }

    let markdown = '### Related Information\n\n';

    results.forEach((result, index) => {
      markdown += `#### Source: ${result.data.source}\n\n`;
      markdown += `${result.text}\n\n`;
      markdown += `*Relevance Score: ${(result.score * 100).toFixed(2)}%*\n\n`;
      if (index < results.length - 1) {
        markdown += '---\n\n';
      }
    });

    return markdown;
  }

  // streamResponse method removed as we're now sending the complete response at once

  /**
   * Rewrites personal pronoun and sprint references in a query to concrete values,
   * so the ADO embedding search finds more relevant results.
   * e.g. "my tickets for this sprint" → "tickets assigned to John Smith for MyProject\Sprint 5"
   */
  private rewriteQueryWithUser(
    query: string,
    userDisplayName: string
  ): string {
    let rewritten = query;

    if (userDisplayName) {
      // Replace possessive/first-person references to the user
      rewritten = rewritten.replace(
        /\b(my|mine|assigned to me|i am assigned|assigned to myself)\b/gi,
        `assigned to ${userDisplayName}`
      );
      // "tickets I own", "items I have"
      rewritten = rewritten.replace(/\btickets I\b/gi, `tickets ${userDisplayName}`);
    }

    return rewritten;
  }

  /**
   * Upgrades the classification using an LLM when the rule-based classifier
   * returned low confidence: refines the intent AND picks the best source(s),
   * including routing natural-language code questions ("what blogs are there
   * in web") to CODEBASE — keyword rules can't recognize those.
   * Guarded: will not fire for local Ollama (requires cloud provider + apiKey).
   * In remote mode, ignores the passed-through webview model and resolves its
   * own model via the 'classification' task route instead.
   */
  private async classifyIntentWithLLM(
    run: SessionRun,
    query: string,
    fallback: QueryClassification,
    modelId: string,
    apiKeys: string[],
    provider: string,
    availableSources: DataSource[] = [],
    baseUrl?: string
  ): Promise<{ intent: QueryClassification['intent']; sources?: DataSource[] }> {
    try {
      let effModelId = modelId;
      let effApiKeys = apiKeys;
      let effProvider = provider;
      let effBaseUrl = baseUrl;
      if (getMode(this.context) === 'remote') {
        const llm = getLlmSettings(this.context);
        effModelId = llm.model ?? effModelId;
        effProvider = llm.provider ?? effProvider;
        effApiKeys = llm.apiKeys.length ? llm.apiKeys : effApiKeys;
        effBaseUrl = llm.baseUrl ?? effBaseUrl;
      }

      const providerConfig = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === effProvider);
      const resolvedBaseUrl = providerConfig?.BASE_URL || effBaseUrl;
      if (!resolvedBaseUrl || !effApiKeys.length) {
        return { intent: fallback.intent };
      }

      const OpenAI = (await import('openai')).default;

      const sourceDescriptions: Record<DataSource, string> = {
        CONFLUENCE: 'CONFLUENCE: the team\'s Confluence wiki (documentation, guides, processes)',
        ADO: 'ADO: Azure DevOps (tickets, work items, sprints, bugs)',
        JIRA: 'JIRA: Jira (issues, tickets, sprints, bugs)',
        CODEBASE: 'CODEBASE: the source code repository currently open in the editor (files, components, features, implementation details)',
      };
      const sourceList = availableSources.map((s) => `- ${sourceDescriptions[s]}`).join('\n');

      const prompt = `Classify this query.

Intent — exactly one of: lookup, semantic, aggregation, comparison, chitchat.
- lookup: asking about a specific ticket, ID, or named item
- semantic: open-ended question, explanation, or how-to
- aggregation: asking to list, count, or summarize multiple items
- comparison: comparing two or more things
- chitchat: greeting or small talk

Sources — which of these should be consulted to answer (pick the single best one unless several are clearly needed):
${sourceList}

Note: questions about what exists in an app/repo/project, its pages, features, sections, or how something is built are CODEBASE questions even if they never use programming words.

Respond with a JSON object only, no markdown: {"intent": "<intent>", "sources": ["<SOURCE>", ...]}

Query: "${query}"`;

      const response = await withKeyFailover(
        effApiKeys,
        (apiKey) => {
          const client = new OpenAI({
            apiKey,
            baseURL: resolvedBaseUrl,
            defaultHeaders: getProviderDefaultHeaders(resolvedBaseUrl, apiKey),
          });
          return client.chat.completions.create({
            model: normalizeModelId(effModelId),
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 60,
            temperature: 0,
          });
        },
        (message) => this.postStatus(run, message),
      );

      const raw = response.choices[0]?.message?.content?.trim() || '{}';
      // Strip markdown code fences if present
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
      const parsed = JSON.parse(jsonStr) as { intent?: string; sources?: string[] };
      const validIntents = ['lookup', 'semantic', 'aggregation', 'comparison', 'chitchat'];

      const intent = parsed.intent && validIntents.includes(parsed.intent)
        ? (parsed.intent as QueryClassification['intent'])
        : fallback.intent;
      const sources = Array.isArray(parsed.sources)
        ? (parsed.sources.filter((s): s is DataSource => availableSources.includes(s as DataSource)))
        : undefined;

      return { intent, sources: sources?.length ? sources : undefined };
    } catch (error) {
      console.warn('LLM intent classification failed, keeping rule-based result:', error);
      return { intent: fallback.intent };
    }
  }

  private async generateModelResponse(
    run: SessionRun,
    message: string,
    searchResults: SearchResult[],
    modelId: string,
    provider: string,
    apiKeys: string[],
    currentUserName: string = '',
    currentSprint: { name: string; iterationPath: string; startDate: string; endDate: string } | null = null,
    codebaseRoots?: NamedRoot[],
    baseUrl?: string,
    attachments: ChatAttachment[] = [],
    resolvedMentions: ResolvedMention[] = [],
    /** This turn carries out a plan the user just approved — see APPROVAL_RE. */
    executeMandate = false,
    /** Work item pre-fetched by sendMessage's FETCH stage (null: none named). */
    ticketContext: TicketDetail | null = null,
    /** Click-to-run: gates are open, the worker prompt drops permission-seeking. */
    autonomous = false,
    /** Plan mode: deliverable is the plan; writes forbidden, anti-plan gates off. */
    planMode = false,
    /** Tool groups the worker may offer, from what is connected (see toolScope.ts). */
    toolAvailability?: { codebase: boolean; confluence: boolean; tickets: boolean },
    /** Display label of whichever tracker is active ('Azure DevOps', 'Jira') — see tickets/registry.ts. */
    ticketTrackerLabel?: string,
    /** Chat mode: plain conversation, so the worker prompt drops retrieval/tool framing. */
    chatOnly = false
  ): Promise<string> {
    try {
      run.lastAnswerStallShaped = false;
      // Create a new worker for model inference
      const workerPath = path.join(
        __dirname,
        'workers',
        'model',
        'modelWorker.js'
      );

      // Format chat history for the prompt
      const formattedChatHistory = run.chatHistory
        .map(
          (msg) =>
            `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
        )
        .join('\n\n');

      // Give codebase turns an upfront map of the workspace (file tree +
      // README head) so the model doesn't burn its first tool-call rounds on
      // basic discovery.
      let repoOrientation: string | undefined;
      if (codebaseRoots?.length) {
        try {
          repoOrientation = await buildRepoOrientation(codebaseRoots);
        } catch (e) {
          console.warn('Failed to build repo orientation (continuing without):', e);
        }
        // Which repo this turn's pull-request references belong to. Resolved
        // once, and stamped onto each ref, so a message re-read from history
        // still points at the right repository.
        run.turnPrUrlTemplate = await getPrUrlTemplate(codebaseRoots);
      }

      // Resume the previous, interrupted agent turn when one is stranded and
      // the user asked to carry on (sendMessage clears it otherwise). Only
      // meaningful for a tool turn — the transcript IS a tool conversation.
      // Deliberately not cleared here: if this worker dies before its first
      // sync, the host copy is still the only record of the work.
      const resumeTranscript =
        codebaseRoots?.length && run.agentTranscript?.length ? run.agentTranscript : undefined;

      const modelWorker = new Worker(workerPath, {
        workerData: {
          prompt: message,
          searchResults,
          modelId: modelId ?? this.currentModel,
          chatHistory: formattedChatHistory,
          // Stable for every turn of this conversation — the worker sends it
          // as the provider's prompt-cache / sticky-routing key so a 25-round
          // run reads its shared prefix from cache instead of re-billing it.
          sessionId: run.sessionId,
          provider: provider,
          apiKey: apiKeys[0],
          apiKeys: apiKeys,
          baseUrl,
          currentUserName: currentUserName || undefined,
          currentSprint: currentSprint || undefined,
          codebaseTools: codebaseRoots ? { enabled: true } : undefined,
          toolAvailability,
          ticketTrackerLabel,
          chatOnly,
          // Text attachments are inlined into the prompt template; images are
          // sent to the model as multimodal image_url parts (vision models).
          textAttachments: attachments
            .filter((a) => a.kind === 'text')
            .map((a) => ({ name: a.name, content: a.content })),
          imageAttachments: [
            ...attachments
              .filter((a) => a.kind === 'image')
              .map((a) => ({ name: a.name, dataUrl: a.content })),
            // The pre-fetched ticket's screenshots — often the clearest
            // statement of the bug. Capped: description images can be numerous
            // and each is base64 megabytes.
            ...(ticketContext?.images ?? [])
              .slice(0, 2)
              .map((img) => ({ name: img.name, dataUrl: img.dataUrl })),
          ],
          // Contents of the files/folders the user @-mentioned in this message.
          mentionedFiles: resolvedMentions,
          repoOrientation,
          workspaceRules: codebaseRoots?.length
            ? [loadWorkspaceRules(codebaseRoots), verificationRecipesBlock(this.context)].filter(Boolean).join('\n\n') || undefined
            : undefined,
          executeMandate,
          resumeTranscript,
          ticketContext: ticketContext ? toTicketPromptContext(ticketContext) : undefined,
          autonomous,
          planMode,
          // Read BEFORE this turn's own writes land, so it counts only earlier
          // turns — exactly what the honesty stamp needs to spare a recap.
          priorWrites: run.sessionWritesApplied,
        },
      });

      run.worker = modelWorker;

      return new Promise((resolve, reject) => {
        run.reject = reject;
        let fullContent = '';
        // The worker's own stall judgment from its 'done' message — it knows
        // writesApplied, which the host-side regex fallback below does not.
        let workerSaidStall = false;
        /** 'done' payload: how many file writes the worker actually applied (null on a worker that predates the field). */
        let workerWritesApplied: number | null = null;
        // Mirror the streamed chunks here so we can salvage a response if the
        // worker dies before it sends 'done' (see settle() below).
        let streamedContent = '';
        let settled = false;

        // Safety net for a worker that stops making progress entirely (hung
        // tool call, dead LLM connection with no socket error, etc.) without
        // ever emitting 'message'/'error'/'exit'. Rearmed on every message the
        // worker sends (see armStallTimer calls below) — this only fires on
        // total silence, not on a merely slow turn.
        // Raised from 5 minutes 2026-09-06, with the turn cap. The watchdog
        // measures SILENCE, and the worker is silent for one whole model
        // completion at a time (a tool turn does not stream). Five minutes was
        // tuned when prompts were small; a run allowed to grow toward the
        // 200k-token window sends a much larger prompt, and a slow provider
        // can genuinely take minutes to answer it. Killing that run would look
        // exactly like the failure this whole change set exists to remove.
        const STALL_TIMEOUT_MS = 12 * 60 * 1000;
        // While a tool runs on THIS thread the worker is silent because it is
        // waiting on us, not because it is stuck. Observed live: a jest run
        // passed the five-minute mark and the run was declared stalled
        // mid-command. A command's own ceiling (MAX_TIMEOUT_SEC) bounds that
        // wait, so the net stays up just above it — still catching a
        // host-side tool with no timeout of its own.
        const TOOL_STALL_TIMEOUT_MS = (MAX_TIMEOUT_SEC + 60) * 1000;
        let toolsInFlight = 0;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const armStallTimer = () => {
          if (stallTimer) clearTimeout(stallTimer);
          if (settled) return;
          const ms = toolsInFlight > 0 ? TOOL_STALL_TIMEOUT_MS : STALL_TIMEOUT_MS;
          stallTimer = setTimeout(() => {
            settle(new Error(`Model worker stopped responding — no activity for ${Math.round(ms / 60_000)} minutes.`));
          }, ms);
        };
        armStallTimer();

        // Single exit point. A "Premature close" (or any late teardown error)
        // is emitted asynchronously on the LLM response socket AFTER all chunks
        // have already been streamed to the UI, and it surfaces as the worker's
        // 'error' event — outside the worker's try/catch. When that happens but
        // we already have content, the response is complete: finish cleanly
        // instead of showing the user a failure over an answer that rendered.
        //
        // Also the ONLY place that clears run.worker/run.reject — reached via
        // 'done'/'error' messages, the stall timer above, or the 'exit'
        // listener below, so a worker that dies silently (crash, killed
        // thread, clean-but-empty exit) can never leave the session stuck
        // thinking a generation is still in flight.
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          if (stallTimer) clearTimeout(stallTimer);
          run.worker = null;
          run.reject = null;
          modelWorker.terminate();

          if (!error || streamedContent.trim().length > 0) {
            if (error) {
              console.warn(
                'WorkspaceGPT: model stream ended with an error after content was received; ' +
                  'salvaging the streamed response.',
                error.message
              );
            }
            // Every turn gets an end-of-run rollup (at minimum, how long it
            // took) before DONE, so the webview can attach it to the final
            // answer — codebase-specific fields (files changed, checkpoint,
            // ticket) are simply empty for a turn that ran no codebase tools.
            {
              const shippable = codebaseRoots?.length ? run.turnFilesChanged.size > 0 : false;
              this.post(run, {
                type: MESSAGE_TYPES.AGENT_TURN_SUMMARY,
                durationMs: Date.now() - run.turnStartMs,
                filesChanged: [...run.turnFilesChanged.values()],
                checkpointSha: shippable ? run.turnFirstCheckpointSha ?? undefined : undefined,
                ticketId: ticketContext?.id,
                refs: run.turnRefs.length ? [...run.turnRefs] : undefined,
                shippable,
                // Carried so "Create PR" can re-arm itself from the persisted
                // transcript alone — the host's own run.lastShip is in-memory
                // only and does not survive an extension host restart.
                ...(shippable
                  ? { ticketType: ticketContext?.type, title: deriveShipTitle(ticketContext?.title, fullContent || streamedContent) }
                  : {}),
              });
            }
            // What this turn is allowed to claim about itself. A turn can end
            // with no prose at all (empty completion, or a tool loop that
            // exited without its summary); the webview used to invent "Done —
            // see the steps above for what was explored and changed" for that
            // case, which on a turn with no steps and no writes is false in
            // every clause. The facts live here, so the wording is decided
            // here and the webview only renders it.
            const answerText = (fullContent || streamedContent).trim();
            const outcome = describeTurnOutcome({
              answerText,
              writesApplied: workerWritesApplied ?? run.turnFilesChanged.size,
              stepsPosted: run.turnStepsPosted,
            });
            if (outcome.kind !== 'answered') {
              this.analyticsService?.trackEvent('turn_no_answer', {
                outcome: outcome.kind,
                stepsPosted: run.turnStepsPosted,
                writesApplied: workerWritesApplied ?? run.turnFilesChanged.size,
                usedCodebaseTools: !!codebaseRoots?.length,
                autonomous,
                planMode,
              });
            }
            if (outcome.kind === 'empty') {
              // Nothing ran and nothing changed: that is a failed turn, and it
              // has to read as one. Routed through ERROR_CHAT so it renders as
              // an error card with a Resume affordance when a transcript is
              // still held, instead of a cheerful assistant bubble.
              const held = run.agentTranscript?.length ?? 0;
              this.post(run, {
                type: MESSAGE_TYPES.ERROR_CHAT,
                message: outcome.text,
                ...(held ? { resumable: { steps: held, writesApplied: run.sessionWritesApplied } } : {}),
              });
            }
            this.post(run, {
              type: MESSAGE_TYPES.RECEIVE_MESSAGE_DONE,
              // Present only when the model produced no prose of its own. The
              // webview attaches this turn's steps and rollup to it, so they
              // survive without the message overstating what happened.
              ...(outcome.kind === 'silent' ? { fallbackAnswer: outcome.text } : {}),
            });
            // A turn that actually delivered an answer is finished — nothing
            // left to resume, and keeping its raw tool results would re-bill
            // them on every later turn in this session. Anything else (provider
            // error, crash, stall, user stop, or a clean exit that produced no
            // text) leaves the transcript in place for a "continue".
            //
            // Exception: a STALL-shaped answer ("grant me another turn to read
            // X", "I haven't searched Confluence yet") is a handoff, not a
            // completion — the very next message is almost always "continue",
            // and without the transcript that continuation re-derives the whole
            // investigation from zero (observed live as the triple-plan loop on
            // one ADO bug). Keep it resumable; it's dropped anyway the moment
            // the user sends anything that isn't a continuation reply.
            // (`answerText` is computed above, where the turn's own outcome is
            // decided.)
            // The regex fallback must never overrule a worker that reports
            // applied writes: a finished report with a polite "let me know if
            // you want…" closing is done, not stalled. Treating it as a stall
            // auto-resumed a completed ticket run (below) into re-verifying
            // itself until the step limit — observed live on ticket 1516750.
            const stallShaped =
              !!answerText &&
              (workerSaidStall ||
                ((workerWritesApplied ?? 0) === 0 &&
                  (PREMATURE_AMBIGUITY_RE.test(answerText) || PERMISSION_SEEKING_RE.test(answerText))));
            run.lastAnswerStallShaped = stallShaped;
            if (answerText && !stallShaped) {
              // Delivered. Retire both copies — a stale record would offer to
              // "resume" a run that already finished.
              this.forgetResume(run);
            }
            resolve(fullContent || streamedContent);
          } else {
            reject(error);
          }
        };

        modelWorker.on(
          'message',
          (result: {
            type: string;
            content?: string;
            message?: string;
            progress?: string;
            id?: string;
            name?: string;
            arguments?: any;
            ms?: number;
            sessionInvalid?: boolean;
            /** slow_model: observed seconds per completion and the trimmed iteration cap. */
            avgSec?: number;
            cap?: number;
            /** context: provider-measured window occupancy for the running turn. */
            usedTokens?: number;
            windowTokens?: number;
            usedPct?: number;
            remainingPct?: number;
            compactions?: number;
            /** Per-part split of the reading above — see contextBreakdown.ts. */
            segments?: { key: string; label: string; tokens: number }[];
            /** metrics: run wall clock and where it went (see the output-channel summary). */
            wallMs?: number;
            modelMs?: number;
            toolMs?: number;
            toolMsByName?: Record<string, { ms: number; calls: number }>;
            turns?: number;
            toolCallsExecuted?: number;
            /** agent_transcript: the worker's model-facing messages — full replacement, or an append. */
            reset?: unknown[];
            append?: unknown[];
            /** resumed: how much of an interrupted run this turn picked up. */
            steps?: number;
            writesApplied?: number;
            /** 'done' only: zero-write stall-shaped answer per the worker's own gates. */
            stallShaped?: boolean;
            /** 'tool_step_update' only: new status + one-line summary for an existing step. */
            stepStatus?: 'running' | 'done' | 'error';
            summary?: string;
          }) => {
            armStallTimer();
            switch (result.type) {
              case 'chunk':
                streamedContent += result.content || '';
                // Stream chunk to webview
                this.post(run, {
                  type: MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK,
                  content: result.content || '',
                });
                break;

              case 'done':
                // Stream complete
                fullContent = result.content || '';
                workerSaidStall = !!result.stallShaped;
                workerWritesApplied = typeof result.writesApplied === 'number' ? result.writesApplied : null;
                settle(null);
                break;

              case 'error':
                if (result.sessionInvalid) {
                  void this.forgetInvalidRemoteSession();
                }
                settle(new Error(result.message));
                break;

              case 'tool_status': {
                // A tool the model just decided to call — surfaced as a
                // transient status label, and also as a persistent structured
                // step so the exploration remains visible in the transcript.
                this.postStatus(run, this.describeToolCall(result.name!, result.arguments));
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP,
                  id: result.id,
                  step: { ...this.describeToolStart(result.name!, result.arguments), status: 'running' },
                });
                break;
              }

              case 'thought':
                // Model latency between tool batches. No longer surfaced as a
                // per-step timeline row — the turn's total elapsed time is
                // already shown once the response finishes (AGENT_TURN_SUMMARY).
                break;

              case 'agent_note':
                // Prose the model wrote ALONGSIDE tool calls (progress
                // narration) — previously swallowed into the conversation
                // history without ever reaching the user.
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'note', title: '', detail: result.content ?? '' },
                });
                break;

              // A step the WORKER owns end-to-end. Every other step is closed by
              // the tool_request handler below, keyed on the request id — but
              // `explore` runs entirely inside the worker (no host-side tool of
              // that name), so without this its step would sit at "running"
              // for the rest of the session.
              case 'tool_step_update':
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
                  id: result.id,
                  status: result.stepStatus ?? 'running',
                  summary: result.summary,
                });
                break;

              case 'tool_request':
                // Codebase tools need the `vscode` workspace APIs, which this
                // worker thread cannot reach — execute on the main thread and
                // send the result back so the worker's tool loop can continue.
                console.log(`[codebase-tool] → ${result.name}(${JSON.stringify(result.arguments)})`);
                toolsInFlight++;
                armStallTimer(); // switch to the in-flight window for the duration
                this.executeCodebaseTool(run, result.name!, result.arguments, codebaseRoots ?? [], result.id)
                  .finally(() => {
                    toolsInFlight = Math.max(0, toolsInFlight - 1);
                    armStallTimer();
                  })
                  .then((toolResult) => {
                    const summary = JSON.stringify(toolResult);
                    console.log(`[codebase-tool] ← ${result.name}: ${summary.length} chars${summary.length <= 300 ? ` — ${summary}` : ''}`);
                    // Provenance, recorded while the result is still structured:
                    // once it is prose in the answer, which namespace an id
                    // belongs to is unrecoverable.
                    mergeRefs(
                      run.turnRefs,
                      collectRefs(result.name!, toolResult, {
                        prUrlTemplate: run.turnPrUrlTemplate,
                        ticketIdPatterns: getActiveTicketProvider(this.context)?.idPatterns,
                      })
                    );
                    const done = this.summarizeToolResult(result.name!, toolResult);
                    this.post(run, {
                      type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
                      id: result.id,
                      status: 'done',
                      summary: done.summary,
                      meta: done.meta,
                    });
                    modelWorker.postMessage({ type: 'tool_response', id: result.id, result: toolResult });
                  })
                  .catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    console.log(`[codebase-tool] ← ${result.name} ERROR: ${message}`);
                    this.post(run, {
                      type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
                      id: result.id,
                      status: 'error',
                      summary: /rejected/i.test(message) ? 'rejected' : /^Command refused/i.test(message) ? 'refused' : 'failed',
                      // WHY it failed, behind the row's Show output toggle —
                      // a bare red "failed" (observed live on a refused
                      // run_command) left the user unable to tell an allowlist
                      // refusal from a crash.
                      meta: { output: message.slice(0, 4000) },
                    });
                    modelWorker.postMessage({
                      type: 'tool_response',
                      id: result.id,
                      error: message,
                    });
                  });
                break;

              case WORKER_STATUS.PROCESSING:
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS,
                  progress: result.progress,
                });
                break;

              case 'key_failover':
                // A provider request was retried instead of failing: either a
                // configured key hit a 429 and we rotated to the next one, or
                // the provider itself is overloaded and withKeyFailover is
                // waiting it out. Both were previously only a console.warn in
                // the extension host log. Surface it as a transient status
                // label and a persistent transcript step so the user knows why
                // the response is slower — an unexplained 20-second pause is
                // indistinguishable from a hang.
                this.postStatus(run, result.message || 'Provider retry in progress…');
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'info', title: result.message || 'Provider retry in progress' },
                });
                break;

              case 'image_unsupported':
                // The model rejected an attached/ticket image with a 400 — the
                // worker already stripped it and retried as text-only. Tell the
                // user why the image is missing instead of leaving it silent.
                this.postStatus(run, result.message || "Model doesn't support image input — continuing without the image.");
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'info', title: result.message || "Model doesn't support image input — continuing without the image." },
                });
                break;

              case 'composing':
                // The worker is generating the final report — the longest
                // single completion of the run, and previously a silent one.
                this.postStatus(run, 'Writing the final report…');
                break;

              case 'slow_model': {
                // The worker detected ~minute-long completions and trimmed the
                // run (fewer iterations, no reflection extras). Tell the user
                // why this turn is slow and that the model is the reason.
                const warn =
                  `Slow model detected (~${result.avgSec}s per step) — trimming this run to ` +
                  `${result.cap} steps. A faster model (e.g. Gemini Flash) will answer in a fraction of the time.`;
                this.postStatus(run, warn);
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'info', title: warn },
                });
                break;
              }

              case 'context':
                // Live context-window occupancy, measured by the provider.
                // Forwarded straight through: the meter in the composer is the
                // user's view of the thing that now bounds a run, so it has to
                // track the real number rather than a host-side estimate.
                // Kept on the run as well as posted: reopening this chat
                // later must be able to show the meter again, and the webview
                // cannot recompute a number only the provider knows.
                run.lastContext = {
                  usedTokens: result.usedTokens,
                  windowTokens: result.windowTokens,
                  usedPct: result.usedPct,
                  remainingPct: result.remainingPct,
                  compactions: result.compactions,
                  segments: result.segments,
                };
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_CONTEXT,
                  ...run.lastContext,
                });
                break;

              case 'metrics':
                // Agent-loop efficiency summary (turns, tokens, budget/compaction
                // events) — not surfaced in the webview, just logged so it shows
                // up in the extension host output for real chats too. Consumed
                // properly by packages/agent-evals.
                console.log('[agent-metrics]', JSON.stringify(result));
                // Where the run's wall clock went, in the same channel as the
                // command log — so the next "why did that take twenty minutes"
                // is one line to read instead of an audit-log reconstruction.
                {
                  const sec = (ms: unknown) => `${Math.round(Number(ms ?? 0) / 1000)}s`;
                  const pct = (ms: unknown) =>
                    result.wallMs ? ` (${Math.round((Number(ms ?? 0) / result.wallMs) * 100)}%)` : '';
                  const byName = Object.entries(result.toolMsByName ?? {})
                    .slice(0, 5)
                    .map(([n, v]: [string, any]) => `${n} ${sec(v.ms)}×${v.calls}`)
                    .join(', ');
                  agentOutputChannel().appendLine(
                    `\n— run finished in ${sec(result.wallMs)}: model ${sec(result.modelMs)}${pct(result.modelMs)}, ` +
                      `tools ${sec(result.toolMs)}${pct(result.toolMs)} over ${result.turns} turns / ${result.toolCallsExecuted} tool calls` +
                      (byName ? `\n  top tools: ${byName}` : '')
                  );
                }
                break;

              case 'agent_transcript':
                // The worker's model-facing conversation for this turn, mirrored
                // here round by round so an interrupted run leaves something to
                // resume from — see SessionRun.agentTranscript. Kept even when
                // the run is cancelled: a stopped run is one the user is most
                // likely to continue.
                if (Array.isArray(result.reset)) {
                  run.agentTranscript = stripTranscriptImages(result.reset);
                } else if (Array.isArray(result.append) && result.append.length) {
                  const next = stripTranscriptImages(result.append);
                  if (run.agentTranscript) run.agentTranscript.push(...next);
                  else run.agentTranscript = next;
                }
                // Park it on disk too, throttled. The terminal paths flush
                // immediately; this trailing save is the only thing that
                // survives the extension host itself going down mid-run.
                this.scheduleResumeSave(run, 'The run did not finish.');
                break;

              case 'resumed': {
                // This turn continued an interrupted run instead of starting
                // over. Worth a transcript row: it explains why the timeline is
                // short and why files it never opened this turn are being
                // discussed as already changed.
                const carried = result.steps ?? 0;
                const note =
                  `Resuming the interrupted run — ${carried} earlier step(s) still in context` +
                  (result.writesApplied ? `, ${result.writesApplied} file change(s) already applied` : '') +
                  '.';
                this.postStatus(run, note);
                this.post(run, {
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'info', title: note },
                });
                break;
              }
            }
          }
        );

        modelWorker.on('error', (error) => {
          settle(error instanceof Error ? error : new Error(String(error)));
        });

        // Belt-and-suspenders for 'error' not firing (e.g. the thread was
        // killed, or exited cleanly without ever sending 'done'/'error') — a
        // no-op once settle() already ran via a message, the error handler,
        // or the stall timer above.
        modelWorker.on('exit', (code) => {
          settle(code === 0 ? null : new Error(`Model worker exited unexpectedly (code ${code}).`));
        });
      });
    } catch (error) {
      console.error('Error in model inference:', error);
      throw error;
    }
  }
}
