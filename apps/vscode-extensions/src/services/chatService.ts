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
import { CodebaseService } from './codebaseService';
import { AdoEmbeddingService } from './ado/adoEmbeddingService';
import { AdoAuthService } from './azure/adoAuthService';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SearchResult {
  text: string;
  score: number;
  data: { sourceName: 'CONFLUENCE' | 'CODEBASE'; source: string, fileName: string };
}

export class ChatService {
  private embeddingService: ConfluenceEmbeddingService;
  private adoEmbeddingService: AdoEmbeddingService;
  private adoAuthService: AdoAuthService;
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
    this.adoAuthService = new AdoAuthService(context);
    this.codebaseService = new CodebaseService(webviewView, context);
    this.currentModel = MODEL.DEFAULT_CHAT_MODEL;
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
    contextSelection: string = 'Auto' // default to Auto
  ): Promise<void> {
    try {
      // Add user message to history
      this.chatHistory.push({
        role: 'user',
        content: message,
      });

      // Search selected context using embedding services
      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      const isConfluenceConnected = settings?.state?.config?.confluence?.isAuthenticated && settings?.state?.config?.confluence?.isIndexingCompleted;
      const isAdoConnected = settings?.state?.config?.ado?.isAuthenticated && settings?.state?.config?.ado?.isIndexingCompleted;
      
      // Resolve 'Auto' context using fast LLM classification
      let resolvedContext = contextSelection;
      if (contextSelection === 'Auto' && isConfluenceConnected && isAdoConnected) {
        resolvedContext = await this.classifyQueryContext(message, modelId, apiKey, provider);
        console.log(`Auto context resolved to: ${resolvedContext}`);
      } else if (contextSelection === 'Auto') {
        // Only one source is available, just use whichever is connected
        if (isAdoConnected && !isConfluenceConnected) {
          resolvedContext = 'Azure DevOps';
        } else if (isConfluenceConnected && !isAdoConnected) {
          resolvedContext = 'Confluence';
        } else {
          resolvedContext = 'BOTH'; // Neither connected, searches will be empty
        }
      }

      const searchPromises: Promise<SearchResult[]>[] = [];

      // Get ADO user display name for query augmentation
      let adoUserName: string | undefined;
      const adoProfile = this.adoAuthService.getStoredProfile();
      if (adoProfile && adoProfile.displayName !== 'ADO User (PAT)') {
        adoUserName = adoProfile.displayName;
      }

      if ((resolvedContext === 'BOTH' || resolvedContext === 'Confluence') && isConfluenceConnected) {
        searchPromises.push(this.embeddingService.searchEmbeddings(message));
      }
      
      if ((resolvedContext === 'BOTH' || resolvedContext === 'Azure DevOps') && isAdoConnected) {
        // Augment ADO search query with user's name when personal pronouns are detected
        const adoSearchQuery = this.augmentQueryWithUserName(message, adoUserName);
        searchPromises.push(this.adoEmbeddingService.searchEmbeddings(adoSearchQuery));
      }

      // We still map search codebases logic if codebase is ever integrated
      searchPromises.push(Promise.resolve([]));

      const searchResultsArray = await Promise.all(searchPromises);

      // Combine search results
      const combinedResults = this.combineSearchResults(searchResultsArray);

      // Generate response using model (streaming)
      const modelResponse = await this.generateModelResponse(
        message,
        combinedResults,
        modelId,
        provider,
        apiKey,
        adoUserName
      );

      // Add assistant response to history
      this.chatHistory.push({
        role: 'assistant',
        content: modelResponse,
      });
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

  private combineSearchResults(
    resultsArray: SearchResult[][]
  ): SearchResult[] {
    
    // Flatten and combine all result sets
    const combined = resultsArray.flat();

    // Sort by score (descending)
    combined.sort((a, b) => b.score - a.score);

    // Return top results (limit to 15 for relevance)
    return combined.slice(0, 15);
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
   * Fast LLM classification to determine which data source(s) a user query needs.
   * Uses max_tokens=10 for speed — typically completes in <500ms.
   */
  private async classifyQueryContext(
    query: string,
    modelId: string,
    apiKey: string,
    provider: string
  ): Promise<string> {
    try {
      const providerConfig = MODEL_PROVIDERS.find(p => p.MODEL_PROVIDER === provider);
      if (!providerConfig || !apiKey) {
        return 'BOTH'; // Fallback: search everything
      }

      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({
        apiKey,
        baseURL: providerConfig.BASE_URL,
      });

      const classificationPrompt = `You are a query classifier. Given a user query, respond with EXACTLY one word:
- "ADO" if it's about work items, tickets, bugs, stories, sprints, iterations, or Azure DevOps
- "CONFLUENCE" if it's about documentation, wiki pages, guides, runbooks, or Confluence content
- "BOTH" if it could need both sources or you're unsure

Query: "${query}"

Classification:`;

      const response = await client.chat.completions.create({
        model: modelId,
        messages: [{ role: 'user', content: classificationPrompt }],
        max_tokens: 10,
        temperature: 0,
      });

      const classification = response.choices[0]?.message?.content?.trim().toUpperCase() || 'BOTH';

      if (classification.includes('ADO')) return 'Azure DevOps';
      if (classification.includes('CONFLUENCE')) return 'Confluence';
      return 'BOTH';
    } catch (error) {
      console.warn('Auto context classification failed, falling back to BOTH:', error);
      return 'BOTH';
    }
  }

  /**
   * Detects personal pronouns in a query and augments it with the user's real name
   * so embedding search can find relevant ADO tickets.
   */
  private augmentQueryWithUserName(query: string, userName?: string): string {
    if (!userName) return query;

    const personalPatterns = /\b(assigned to me|my tickets|my bugs|my tasks|my work items|my stories|my issues|for me|about me|i am working|i'm working|\bme\b|\bmy\b)\b/i;
    if (personalPatterns.test(query)) {
      return `${query} (user: ${userName})`;
    }
    return query;
  }

  private async generateModelResponse(
    message: string,
    searchResults: SearchResult[],
    modelId: string,
    provider: string,
    apiKey: string,
    adoUserName?: string
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
          adoUserName: adoUserName,
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
