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
  LlmTask,
} from '../../constants';
import { CodebaseService } from './codebase/codebaseService';
import { AdoEmbeddingService } from './ado/adoEmbeddingService';
import { getLlmSettings } from 'src/utils/getLlmSettings';
import { getMode } from 'src/utils/getModeSettings';
import { withKeyFailover } from 'src/utils/apiKeyFailover';
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
import { CheckpointService, checkpointServiceFor } from './agent/checkpointService';
import { getDiagnostics, gitBlame, gitDiff, gitLog, gitStatus } from './agent/inspectTools';
import {
  agentOutputChannel,
  assertCommandAllowed,
  executeCommand,
  recordAgentAudit,
  resolveCommandCwd,
  RunCommandArgs,
} from './agent/commandTools';
import { loadWorkspaceRules } from './agent/rulesFiles';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

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

export class ChatService {
  private embeddingService: ConfluenceEmbeddingService;
  private adoEmbeddingService: AdoEmbeddingService;
  private codebaseService: CodebaseService;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private chatHistory: ChatMessage[] = [];
  private currentModel: string;
  private currentModelWorker: Worker | null = null;
  private currentReject: ((reason?: any) => void) | null = null;
  /** Human-approval gate for agent write tools (P1: every write is reviewed). */
  private agentWriteGate = new AgentWriteGate();
  /** Shadow-git checkpoints, created lazily per workspace on the first write. */
  private checkpointService: CheckpointService | null = null;
  /** Commands the user approved "for this session" (exact string match). */
  private sessionCommandAllowlist = new Set<string>();
  /** When the in-flight turn started — reported as "Worked for Xs". */
  private turnStartMs = 0;
  /** Files changed (applied writes only) during the in-flight turn, keyed by display path. */
  private turnFilesChanged = new Map<string, TurnFileChange>();
  /** Sha of the FIRST checkpoint taken this turn — reverting to it undoes the whole turn. */
  private turnFirstCheckpointSha: string | null = null;

  constructor(
    webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.embeddingService = new ConfluenceEmbeddingService(webviewView, context);
    this.adoEmbeddingService = new AdoEmbeddingService(webviewView, context);
    this.codebaseService = new CodebaseService(webviewView, context);
    this.currentModel = MODEL.DEFAULT_CHAT_MODEL;
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

    if (isConfluenceConnected) {
      this.embeddingService.eagerInit();
    }
    if (isAdoConnected) {
      this.adoEmbeddingService.eagerInit();
    }
  }

  /**
   * Tear down the persistent search workers this service owns. Call on reset/deactivation.
   */
  public dispose(): void {
    this.embeddingService.dispose();
    this.adoEmbeddingService.dispose();
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

  public stopMessage(): void {
    // Unpark any write approvals first — their worker is about to die — and
    // tell the webview so pending cards don't keep live-looking buttons.
    this.agentWriteGate.rejectAll('Run stopped by the user.');
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.AGENT_WRITE_REVIEWS_CLOSED });
    if (this.currentModelWorker) {
      this.currentModelWorker.terminate();
      this.currentModelWorker = null;
      if (this.currentReject) {
        this.currentReject(new Error('Generation cancelled by user.'));
        this.currentReject = null;
      }
    }
  }

  /** Sends a transient status label to the webview loading indicator. */
  private postStatus(text: string): void {
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.RETRIEVAL_STATUS,
      text,
    });
  }

  public async newChat(): Promise<void> {
    // Clear chat history
    this.chatHistory = [];

    // Notify webview
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.NEW_CHAT,
    });
  }

  public async sendMessage(
    message: string,
    modelId: string,
    apiKey: string,
    provider: string,
    contextSelection: string = 'Auto'
  ): Promise<void> {
    try {
      this.chatHistory.push({ role: 'user', content: message });
      this.turnStartMs = Date.now();
      this.turnFilesChanged.clear();
      this.turnFirstCheckpointSha = null;

      const mode = getMode(this.context);

      // All configured keys for the selected provider, tried in failover order
      // on 429. Local mode: the webview's selected model + its stored keys.
      // Remote mode: the 'chat' task's routed provider/keys (Gemini) — the
      // task is re-resolved once `useCodebaseTools` is final, right before the
      // model actually runs (see the generateModelResponse call below).
      // Falls back to the single key the webview sent.
      const chatLlm = getLlmSettings(this.context, 'chat');
      const apiKeys = chatLlm.apiKeys;
      const failoverKeys = apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];
      // 'Custom' provider's user-supplied base URL (undefined for built-in
      // providers, which resolve their base URL from MODEL_PROVIDERS instead).
      const baseUrl = chatLlm.baseUrl;

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      const isConfluenceConnected =
        settings?.state?.config?.confluence?.isAuthenticated &&
        settings?.state?.config?.confluence?.isIndexingCompleted;
      const isAdoConnected =
        settings?.state?.config?.ado?.isAuthenticated &&
        settings?.state?.config?.ado?.isIndexingCompleted;

      const userDisplayName: string = settings?.state?.config?.ado?.userDisplayName || '';
      const currentSprint = settings?.state?.config?.ado?.currentSprint || null;

      // Codebase tools need no auth/indexing — only an open workspace folder.
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      const isCodebaseAvailable = workspaceFolders.length > 0;

      // Build the list of actually-connected sources
      const availableSources: DataSource[] = [
        ...(isConfluenceConnected ? ['CONFLUENCE' as DataSource] : []),
        ...(isAdoConnected ? ['ADO' as DataSource] : []),
        ...(isCodebaseAvailable ? ['CODEBASE' as DataSource] : []),
      ];

      // ── Step 1: Rule-based classification (synchronous, zero latency) ──
      let classification: QueryClassification = classifyQuery(message, availableSources);

      // Override sources when the user has explicitly chosen a context
      if (contextSelection !== 'Auto') {
        const explicitSource: DataSource | null =
          contextSelection === 'Confluence' ? 'CONFLUENCE' :
          contextSelection === 'Azure DevOps' ? 'ADO' :
          contextSelection === 'Codebase' ? 'CODEBASE' : null;
        if (explicitSource && availableSources.includes(explicitSource)) {
          classification = { ...classification, sources: [explicitSource], confidence: 'high' };
        } else if (!explicitSource) {
          classification = { ...classification, sources: availableSources, confidence: 'high' };
        }
      }

      // Codebase is mutually exclusive with Confluence/ADO for a given turn —
      // it skips the embedding search pipeline entirely (see Step 3) in favor
      // of a live tool-calling loop in the model worker. `let` because the
      // low-confidence LLM classification below may re-route an ambiguous
      // query to the codebase (keyword rules can't cover natural questions
      // like "what blogs are there in web").
      let useCodebaseTools = classification.sources.includes('CODEBASE');
      if (useCodebaseTools) {
        classification = { ...classification, sources: ['CODEBASE'] };
      }

      // No doc/ticket source matched (or none are connected) but a workspace
      // is open — default to codebase tools rather than answering from nothing.
      if (
        !useCodebaseTools &&
        classification.sources.length === 0 &&
        classification.intent !== 'chitchat' &&
        isCodebaseAvailable
      ) {
        console.log('No doc/ticket source classified — defaulting to codebase tools.');
        useCodebaseTools = true;
        classification = { ...classification, sources: ['CODEBASE'] };
      }

      // ── Step 2: Build preliminary plan from rule-based result ──────────
      // Search starts immediately with this plan; LLM may refine intent in parallel.
      const prelimPlan = buildPlan(classification);
      console.log(`Preliminary plan: intent=${prelimPlan.intent}, sources=${prelimPlan.sources.join(',')}, topKPerPass=${prelimPlan.topKPerPass}`);

      // ── Step 3: Fan-out search + LLM classification concurrently ───────
      // Codebase turns skip the embedding search pipeline entirely — the model
      // worker gets live tools instead (see generateModelResponse below).
      let finalResults: SearchResult[] = [];

      if (!useCodebaseTools && prelimPlan.sources.length > 0 && prelimPlan.topKPerPass > 0) {
        const adoQuery = this.rewriteQueryWithUser(message, userDisplayName);
        if (adoQuery !== message) {
          console.log(`ADO query rewritten: "${message}" → "${adoQuery}"`);
        }

        const sourceLabel = prelimPlan.sources
          .map((s) => (s === 'ADO' ? 'Azure DevOps' : 'Confluence'))
          .join(' & ');
        this.postStatus(`Searching ${sourceLabel}...`);

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
            ? this.classifyIntentWithLLM(message, classification, modelId, failoverKeys, provider, availableSources, baseUrl)
            : Promise.resolve({ intent: classification.intent, sources: undefined as DataSource[] | undefined }),
        ]);

        // The LLM may re-route an ambiguous query to the codebase — keyword
        // rules can't recognize questions like "what blogs are there in web"
        // as code questions. When that happens, discard the embedding results
        // (they were searched speculatively in parallel) and switch to tools.
        if (needsLLM && upgraded.sources?.includes('CODEBASE') && isCodebaseAvailable) {
          console.log('LLM routed query to CODEBASE — switching to live codebase tools.');
          useCodebaseTools = true;
          classification = { ...classification, intent: upgraded.intent, sources: ['CODEBASE'] };
        }

        if (!useCodebaseTools) {
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
              this.postStatus('Expanding search...');
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
          this.postStatus('Ranking results...');
          finalResults = rerank(message, allResults, plan);
          console.log(`Reranked to ${finalResults.length} results (threshold=${plan.similarityThreshold}).`);
        }
      }

      // ── Step 6: Generate response ──────────────────────────────────────
      // Resolve the model to actually run only now that `useCodebaseTools` is
      // final (it can flip late via the LLM reroute above). Local mode keeps
      // the webview's selection; remote mode routes by task — codegen gets a
      // different model than a Confluence/ADO chat answer.
      const finalTask: LlmTask = useCodebaseTools ? 'codegen' : 'chat';
      const finalLlm = mode === 'remote' ? getLlmSettings(this.context, finalTask) : null;
      const effModelId = finalLlm?.model ?? modelId;
      const effProvider = finalLlm?.provider ?? provider;
      const effApiKeys = finalLlm?.apiKeys.length ? finalLlm.apiKeys : failoverKeys;
      const effBaseUrl = finalLlm?.baseUrl ?? baseUrl;

      this.postStatus('Thinking...');
      const modelResponse = await this.generateModelResponse(
        message,
        finalResults,
        effModelId,
        effProvider,
        effApiKeys,
        userDisplayName,
        currentSprint,
        useCodebaseTools ? getNamedRoots(workspaceFolders) : undefined,
        effBaseUrl
      );

      this.chatHistory.push({ role: 'assistant', content: modelResponse });
    } catch (error) {
      if (error instanceof Error && error.message === 'Generation cancelled by user.') {
        console.log('Chat generation cancelled by user.');
        return;
      }
      console.error('Error in chat:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ERROR_CHAT,
        message: error instanceof Error ? error.message : String(error),
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
    return this.adoEmbeddingService.searchEmbeddings(query, topK);
  }

  /**
   * Dispatches a tool call requested by the model worker to the corresponding
   * codebase tool function. Called from the modelWorker 'message' handler in
   * generateModelResponse() when it receives a `tool_request`.
   */
  private async executeCodebaseTool(
    name: string,
    args: any,
    roots: NamedRoot[]
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
        return this.gatedWrite(await prepareEditFile(args, roots), roots);
      case 'create_file':
        return this.gatedWrite(await prepareCreateFile(args, roots), roots);
      case 'delete_file':
        return this.gatedWrite(await prepareDeleteFile(args, roots), roots);
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
        return this.gatedCommand(args, roots);
      case 'search_docs':
        return this.searchKnowledge('CONFLUENCE', args);
      case 'search_tickets':
        return this.searchKnowledge('ADO', args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * run_command flow: denylist (hard block) → session allowlist (skip the
   * card) → approval card → checkpoint → execute → mirror output + audit.
   */
  private async gatedCommand(args: RunCommandArgs, roots: NamedRoot[]): Promise<unknown> {
    const command = (args.command ?? '').trim();
    if (!command) throw new Error('command must be non-empty.');
    assertCommandAllowed(command);
    const { cwd, displayCwd } = resolveCommandCwd(roots, args.cwd);
    const summary = `Run: ${command}`;

    let decisionKind: 'auto' | 'approved' | 'approved-session' = 'auto';
    if (!this.sessionCommandAllowlist.has(command)) {
      const { id, decision } = this.agentWriteGate.await({ kind: 'command', summary });
      this.webviewView.webview.postMessage({
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

    // Commands can mutate the workspace — same snapshot rule as file writes.
    try {
      const cp = await this.checkpoints(roots).checkpoint(summary);
      if (!this.turnFirstCheckpointSha) this.turnFirstCheckpointSha = cp.sha;
    } catch (e) {
      console.warn('WorkspaceGPT: checkpoint before command failed (continuing):', e);
    }

    this.postStatus(`Running: ${command}`);
    const res = await executeCommand(command, cwd, args.timeoutSec);
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
    let results: SearchResult[];
    try {
      results = await this.searchSource(source, args.query, topK);
    } catch (e) {
      const label = source === 'CONFLUENCE' ? 'Confluence' : 'Azure DevOps';
      throw new Error(
        `${label} search unavailable: ${e instanceof Error ? e.message : String(e)}. ` +
          'The source may not be connected/synced — answer from the codebase alone or tell the user.'
      );
    }
    return {
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
  private async gatedWrite(write: PreparedWrite, roots: NamedRoot[]): Promise<unknown> {
    const { id, decision } = this.agentWriteGate.await(write);
    const diff = buildReviewDiff(write.before, write.after);
    this.webviewView.webview.postMessage({
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

    // Snapshot BEFORE mutating, so "revert this step" is always available.
    try {
      const cp = await this.checkpoints(roots).checkpoint(write.summary);
      if (!this.turnFirstCheckpointSha) this.turnFirstCheckpointSha = cp.sha;
    } catch (e) {
      console.warn('WorkspaceGPT: checkpoint failed (continuing with the write):', e);
    }
    // Remember the pre-agent content (first touch wins) so the files-changed
    // bar's Review action can open a native original ⟷ current diff.
    recordOriginalContent(write.uri.fsPath, write.before);
    try {
      await applyWrite(write);
    } catch (e) {
      await this.audit(write.kind, write.summary, 'approved', 'failed', e instanceof Error ? e.message : String(e));
      throw e;
    }
    await this.audit(write.kind, write.summary, 'approved', 'applied');
    const prior = this.turnFilesChanged.get(write.displayPath);
    this.turnFilesChanged.set(write.displayPath, {
      path: write.displayPath,
      kind: write.kind,
      added: (prior?.added ?? 0) + diff.added,
      removed: (prior?.removed ?? 0) + diff.removed,
    });
    return { applied: true, path: write.displayPath, summary: write.summary, added: diff.added, removed: diff.removed };
  }

  /** Lazily construct the per-workspace shadow-git checkpoint service. */
  private checkpoints(roots: NamedRoot[]): CheckpointService {
    if (!this.checkpointService) {
      this.checkpointService = checkpointServiceFor(this.context.globalStorageUri.fsPath, roots[0].uri.fsPath);
    }
    return this.checkpointService;
  }

  /** Per-message "Undo changes up to this point" — hard-resets to a turn's first checkpoint. */
  public async revertToCheckpoint(sha: string): Promise<void> {
    const roots = getNamedRoots(vscode.workspace.workspaceFolders ?? []);
    if (!roots.length) throw new Error('No workspace folder is open.');
    await this.checkpoints(roots).revertTo(sha);
  }

  /** Webview AGENT_WRITE_DECISION handler — resolves the parked write gate. */
  public resolveAgentWrite(id: string, approved: boolean, feedback?: string, scope?: 'once' | 'session'): void {
    this.agentWriteGate.resolve(id, approved, feedback, scope);
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
        return { kind: 'search', title: 'Searched Azure DevOps', detail: args?.query ?? '' };
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
        return { kind: 'command', title: 'Ran', detail: args?.command ?? '' };
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
        return { summary: plural(n, 'result') };
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
        return {
          summary: result?.timedOut ? 'timed out' : `exit ${result?.exitCode ?? '?'}`,
          meta: {
            exitCode: result?.exitCode ?? null,
            durationMs: result?.durationMs,
            output: typeof result?.output === 'string' ? result.output.slice(0, 4000) : '',
          },
        };
      case 'edit_file':
      case 'create_file':
      case 'delete_file':
        return result?.applied ? { summary: `+${result.added ?? 0} −${result.removed ?? 0}` } : {};
      case 'search_docs':
      case 'search_tickets':
        return { summary: plural(result?.results?.length ?? 0, 'result') };
      default:
        return {};
    }
  }

  /** Human-readable status text for a codebase tool call, shown in the loading indicator. */
  private describeToolCall(name: string, args: any): string {
    switch (name) {
      case 'search_codebase':
        return `Searching codebase for "${args?.query ?? ''}"...`;
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
      case 'search_docs':
        return `Searching Confluence for "${args?.query ?? ''}"...`;
      case 'search_tickets':
        return `Searching Azure DevOps for "${args?.query ?? ''}"...`;
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
        const llm = getLlmSettings(this.context, 'classification');
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
          const client = new OpenAI({ apiKey, baseURL: resolvedBaseUrl });
          return client.chat.completions.create({
            model: effModelId,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 60,
            temperature: 0,
          });
        },
        (message) => this.postStatus(message),
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
    message: string,
    searchResults: SearchResult[],
    modelId: string,
    provider: string,
    apiKeys: string[],
    currentUserName: string = '',
    currentSprint: { name: string; iterationPath: string; startDate: string; endDate: string } | null = null,
    codebaseRoots?: NamedRoot[],
    baseUrl?: string
  ): Promise<string> {
    try {
      // Create a new worker for model inference
      const workerPath = path.join(
        __dirname,
        'workers',
        'model',
        'modelWorker.js'
      );

      // Format chat history for the prompt
      const formattedChatHistory = this.chatHistory
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
      }

      const modelWorker = new Worker(workerPath, {
        workerData: {
          prompt: message,
          searchResults,
          modelId: modelId ?? this.currentModel,
          chatHistory: formattedChatHistory,
          provider: provider,
          apiKey: apiKeys[0],
          apiKeys: apiKeys,
          baseUrl,
          currentUserName: currentUserName || undefined,
          currentSprint: currentSprint || undefined,
          codebaseTools: codebaseRoots ? { enabled: true } : undefined,
          repoOrientation,
          workspaceRules: codebaseRoots?.length ? loadWorkspaceRules(codebaseRoots) : undefined,
        },
      });

      this.currentModelWorker = modelWorker;

      return new Promise((resolve, reject) => {
        this.currentReject = reject;
        let fullContent = '';
        // Mirror the streamed chunks here so we can salvage a response if the
        // worker dies before it sends 'done' (see settle() below).
        let streamedContent = '';
        let settled = false;

        // Single exit point. A "Premature close" (or any late teardown error)
        // is emitted asynchronously on the LLM response socket AFTER all chunks
        // have already been streamed to the UI, and it surfaces as the worker's
        // 'error' event — outside the worker's try/catch. When that happens but
        // we already have content, the response is complete: finish cleanly
        // instead of showing the user a failure over an answer that rendered.
        const settle = (error: Error | null) => {
          if (settled) return;
          settled = true;
          this.currentModelWorker = null;
          this.currentReject = null;
          modelWorker.terminate();

          if (!error || streamedContent.trim().length > 0) {
            if (error) {
              console.warn(
                'WorkspaceGPT: model stream ended with an error after content was received; ' +
                  'salvaging the streamed response.',
                error.message
              );
            }
            // Agent turns get an end-of-run rollup (duration + files changed)
            // before DONE, so the webview can attach it to the final answer.
            if (codebaseRoots?.length) {
              this.webviewView.webview.postMessage({
                type: MESSAGE_TYPES.AGENT_TURN_SUMMARY,
                durationMs: Date.now() - this.turnStartMs,
                filesChanged: [...this.turnFilesChanged.values()],
                checkpointSha: this.turnFilesChanged.size > 0 ? this.turnFirstCheckpointSha ?? undefined : undefined,
              });
            }
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.RECEIVE_MESSAGE_DONE,
            });
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
          }) => {
            switch (result.type) {
              case 'chunk':
                streamedContent += result.content || '';
                // Stream chunk to webview
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK,
                  content: result.content || '',
                });
                break;

              case 'done':
                // Stream complete
                fullContent = result.content || '';
                settle(null);
                break;

              case 'error':
                settle(new Error(result.message));
                break;

              case 'tool_status': {
                // A tool the model just decided to call — surfaced as a
                // transient status label, and also as a persistent structured
                // step so the exploration remains visible in the transcript.
                this.postStatus(this.describeToolCall(result.name!, result.arguments));
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.AGENT_STEP,
                  id: result.id,
                  step: { ...this.describeToolStart(result.name!, result.arguments), status: 'running' },
                });
                break;
              }

              case 'thought': {
                // Model latency between tool batches — the "Thought for 2s"
                // rows the timeline shows between exploration groups.
                const sec = Math.max(1, Math.round((result.ms ?? 0) / 1000));
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'thought', title: `Thought for ${sec}s` },
                });
                break;
              }

              case 'agent_note':
                // Prose the model wrote ALONGSIDE tool calls (progress
                // narration) — previously swallowed into the conversation
                // history without ever reaching the user.
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'note', title: '', detail: result.content ?? '' },
                });
                break;

              case 'tool_request':
                // Codebase tools need the `vscode` workspace APIs, which this
                // worker thread cannot reach — execute on the main thread and
                // send the result back so the worker's tool loop can continue.
                console.log(`[codebase-tool] → ${result.name}(${JSON.stringify(result.arguments)})`);
                this.executeCodebaseTool(result.name!, result.arguments, codebaseRoots ?? [])
                  .then((toolResult) => {
                    const summary = JSON.stringify(toolResult);
                    console.log(`[codebase-tool] ← ${result.name}: ${summary.length} chars${summary.length <= 300 ? ` — ${summary}` : ''}`);
                    const done = this.summarizeToolResult(result.name!, toolResult);
                    this.webviewView.webview.postMessage({
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
                    this.webviewView.webview.postMessage({
                      type: MESSAGE_TYPES.AGENT_STEP_UPDATE,
                      id: result.id,
                      status: 'error',
                      summary: /rejected/i.test(message) ? 'rejected' : 'failed',
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
                // A configured key hit a 429 and we rotated to the next one —
                // previously only a console.warn in the extension host log.
                // Surface it as a transient status label and a persistent
                // transcript step so the user knows why the response is slower.
                this.postStatus(result.message || 'Rate limited — switching API key…');
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.AGENT_STEP,
                  step: { kind: 'info', title: result.message || 'Rate limited — switching API key' },
                });
                break;
            }
          }
        );

        modelWorker.on('error', (error) => {
          settle(error instanceof Error ? error : new Error(String(error)));
        });
      });
    } catch (error) {
      console.error('Error in model inference:', error);
      throw error;
    }
  }
}
