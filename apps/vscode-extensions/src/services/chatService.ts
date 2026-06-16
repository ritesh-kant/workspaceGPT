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
  STORAGE_KEYS
} from '../../constants';
import { CodebaseService } from './codebase/codebaseService';
import { AdoEmbeddingService } from './ado/adoEmbeddingService';
import { classifyQuery } from 'src/utils/queryClassifier';
import { buildPlan, expandQuery } from 'src/utils/queryPlanner';
import { rerank } from 'src/utils/reranker';
import {
  DataSource,
  EmbeddingSearchResult,
  QueryClassification,
} from 'src/types/types';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
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

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      const isConfluenceConnected =
        settings?.state?.config?.confluence?.isAuthenticated &&
        settings?.state?.config?.confluence?.isIndexingCompleted;
      const isAdoConnected =
        settings?.state?.config?.ado?.isAuthenticated &&
        settings?.state?.config?.ado?.isIndexingCompleted;

      const userDisplayName: string = settings?.state?.config?.ado?.userDisplayName || '';
      const currentSprint = settings?.state?.config?.ado?.currentSprint || null;

      // Build the list of actually-connected sources
      const availableSources: DataSource[] = [
        ...(isConfluenceConnected ? ['CONFLUENCE' as DataSource] : []),
        ...(isAdoConnected ? ['ADO' as DataSource] : []),
      ];

      // ── Step 1: Rule-based classification (synchronous, zero latency) ──
      let classification: QueryClassification = classifyQuery(message, availableSources);

      // Override sources when the user has explicitly chosen a context
      if (contextSelection !== 'Auto') {
        const explicitSource: DataSource | null =
          contextSelection === 'Confluence' ? 'CONFLUENCE' :
          contextSelection === 'Azure DevOps' ? 'ADO' : null;
        if (explicitSource && availableSources.includes(explicitSource)) {
          classification = { ...classification, sources: [explicitSource], confidence: 'high' };
        } else if (!explicitSource) {
          classification = { ...classification, sources: availableSources, confidence: 'high' };
        }
      }

      // ── Step 2: Build preliminary plan from rule-based result ──────────
      // Search starts immediately with this plan; LLM may refine intent in parallel.
      const prelimPlan = buildPlan(classification);
      console.log(`Preliminary plan: intent=${prelimPlan.intent}, sources=${prelimPlan.sources.join(',')}, topKPerPass=${prelimPlan.topKPerPass}`);

      // ── Step 3: Fan-out search + LLM classification concurrently ───────
      let finalResults: SearchResult[] = [];

      if (prelimPlan.sources.length > 0 && prelimPlan.topKPerPass > 0) {
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
        // - a cloud provider + apiKey are available (skip for local Ollama)
        // - BOTH sources are connected (single-source: intent only shifts topK by ±5, not worth it)
        const isCloudProvider =
          MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === provider)?.BASE_URL !== undefined &&
          !!apiKey;
        const needsLLM =
          classification.confidence === 'low' &&
          contextSelection === 'Auto' &&
          isCloudProvider &&
          availableSources.length > 1;

        // Pass 1 search and LLM classification run at the same time
        const [pass1PerSource, upgradedIntent] = await Promise.all([
          Promise.all(
            prelimPlan.sources.map((source) =>
              this.searchSource(source, source === 'ADO' ? adoQuery : message, prelimPlan.topKPerPass)
            )
          ),
          needsLLM
            ? this.classifyIntentWithLLM(message, classification, modelId, apiKey, provider)
            : Promise.resolve({ intent: classification.intent }),
        ]);

        // Apply upgraded intent and rebuild the final plan
        if (needsLLM && upgradedIntent.intent !== classification.intent) {
          console.log(`Intent upgraded via LLM: ${classification.intent} → ${upgradedIntent.intent}`);
        }
        classification = { ...classification, intent: upgradedIntent.intent };
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

        // ── Step 5: Rerank + threshold filter ─────────────────────────────
        this.postStatus('Ranking results...');
        finalResults = rerank(message, allResults, plan);
        console.log(`Reranked to ${finalResults.length} results (threshold=${plan.similarityThreshold}).`);
      }

      // ── Step 6: Generate response ──────────────────────────────────────
      this.postStatus('Thinking...');
      const modelResponse = await this.generateModelResponse(
        message,
        finalResults,
        modelId,
        provider,
        apiKey,
        userDisplayName,
        currentSprint
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
    return this.adoEmbeddingService.searchEmbeddings(query, topK);
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
   * Upgrades the intent classification using an LLM when the rule-based classifier
   * returned low confidence. Only updates intent — source routing stays rule-determined.
   * Guarded: will not fire for local Ollama (requires cloud provider + apiKey).
   */
  private async classifyIntentWithLLM(
    query: string,
    fallback: QueryClassification,
    modelId: string,
    apiKey: string,
    provider: string
  ): Promise<Pick<QueryClassification, 'intent'>> {
    try {
      const providerConfig = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === provider);
      if (!providerConfig || !apiKey) {
        return { intent: fallback.intent };
      }

      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey, baseURL: providerConfig.BASE_URL });

      const prompt = `Classify the intent of this query into exactly one of: lookup, semantic, aggregation, comparison, chitchat.

- lookup: asking about a specific ticket, ID, or named item
- semantic: open-ended question, explanation, or how-to
- aggregation: asking to list, count, or summarize multiple items
- comparison: comparing two or more things
- chitchat: greeting or small talk

Respond with a JSON object only, no markdown: {"intent": "<one of the five values>"}

Query: "${query}"`;

      const response = await client.chat.completions.create({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 20,
        temperature: 0,
      });

      const raw = response.choices[0]?.message?.content?.trim() || '{}';
      // Strip markdown code fences if present
      const jsonStr = raw.replace(/^```[a-z]*\n?/i, '').replace(/```$/,'').trim();
      const parsed = JSON.parse(jsonStr) as { intent?: string };
      const validIntents = ['lookup', 'semantic', 'aggregation', 'comparison', 'chitchat'];
      if (parsed.intent && validIntents.includes(parsed.intent)) {
        return { intent: parsed.intent as QueryClassification['intent'] };
      }
      return { intent: fallback.intent };
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
    apiKey: string,
    currentUserName: string = '',
    currentSprint: { name: string; iterationPath: string; startDate: string; endDate: string } | null = null
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

      const modelWorker = new Worker(workerPath, {
        workerData: {
          prompt: message,
          searchResults,
          modelId: modelId ?? this.currentModel,
          chatHistory: formattedChatHistory,
          provider: provider,
          apiKey: apiKey,
          currentUserName: currentUserName || undefined,
          currentSprint: currentSprint || undefined,
        },
      });

      this.currentModelWorker = modelWorker;

      return new Promise((resolve, reject) => {
        this.currentReject = reject;
        let fullContent = '';

        modelWorker.on(
          'message',
          (result: {
            type: string;
            content?: string;
            message?: string;
            progress?: string;
          }) => {
            switch (result.type) {
              case 'chunk':
                // Stream chunk to webview
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.RECEIVE_MESSAGE_CHUNK,
                  content: result.content || '',
                });
                break;

              case 'done':
                // Stream complete
                fullContent = result.content || '';
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.RECEIVE_MESSAGE_DONE,
                });
                this.currentModelWorker = null;
                this.currentReject = null;
                modelWorker.terminate();
                resolve(fullContent);
                break;

              case 'error':
                this.currentModelWorker = null;
                this.currentReject = null;
                modelWorker.terminate();
                reject(new Error(result.message));
                break;

              case WORKER_STATUS.PROCESSING:
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS,
                  progress: result.progress,
                });
                break;
            }
          }
        );

        modelWorker.on('error', (error) => {
          reject(error);
          this.currentModelWorker = null;
          this.currentReject = null;
          modelWorker.terminate();
        });
      });
    } catch (error) {
      console.error('Error in model inference:', error);
      throw error;
    }
  }
}
