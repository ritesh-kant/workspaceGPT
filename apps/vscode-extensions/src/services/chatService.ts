import * as vscode from 'vscode';
import { EmbeddingService } from './embeddingService';
import path from 'path';
import { Worker } from 'worker_threads';
import { WORKER_STATUS, MESSAGE_TYPES, MODEL, ModelType } from '../../constants';
import { CodebaseService } from './codebaseService';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface SearchResult {
  text: string;
  score: number;
  source: string;
}

export class ChatService {
  private embeddingService: EmbeddingService;
  private codebaseService: CodebaseService;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private chatHistory: ChatMessage[] = [];
  private currentModel: string;

  constructor(
    webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.embeddingService = new EmbeddingService(webviewView, context);
    this.codebaseService = new CodebaseService(webviewView, context);
    this.currentModel = MODEL.DEFAULT_CHAT_MODEL;
  }

  public async initializeModel(modelId: string, modelType: ModelType): Promise<void> {
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
                  modelId: result.modelId ?? "",
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

  public async newChat(): Promise<void> {
    // Clear chat history
    this.chatHistory = [];

    // Notify webview
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.NEW_CHAT,
    });
  }

  public async sendMessage(message: string, modelId: string, apiKey: string, provider: string): Promise<void> {
    try {
      // Add user message to history
      this.chatHistory.push({
        role: 'user',
        content: message,
      });

      // Search both Confluence and codebase embeddings
      const [confluenceResults, codebaseResults] = await Promise.all([
        this.embeddingService.searchEmbeddings(message),
        []
        // this.codebaseService.searchCodebase(message)
      ]);

      // Combine search results
      const combinedResults = this.combineSearchResults(confluenceResults, codebaseResults);

      // Generate response using model
      const modelResponse = await this.generateModelResponse(
        message,
        combinedResults,
        modelId,
        provider,
        apiKey
      );

      // Add assistant response to history
      this.chatHistory.push({
        role: 'assistant',
        content: modelResponse,
      });

      // Send complete response to webview at once instead of streaming
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.RECEIVE_MESSAGE,
        content: modelResponse,
      });
    } catch (error) {
      console.error('Error in chat:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ERROR_CHAT,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private combineSearchResults(
    confluenceResults: SearchResult[],
    codebaseResults: SearchResult[]
  ): SearchResult[] {
    // Add source type to differentiate between Confluence and codebase results
    const taggedConfluenceResults = confluenceResults.map(result => ({
      ...result,
      source: `Confluence: ${result.source}`
    }));

    const taggedCodebaseResults = codebaseResults.map(result => ({
      ...result,
      source: `Codebase: ${result.source}`
    }));

    // Combine both result sets
    const combined = [...taggedConfluenceResults, ...taggedCodebaseResults];

    // Sort by score (descending)
    combined.sort((a, b) => b.score - a.score);

    // Return top results (limit to 10 for relevance)
    return combined.slice(0, 10);
  }

  private formatSearchResults(
    results: SearchResult[]
  ): string {
    if (!results.length) {
      return 'No relevant information found.';
    }

    let markdown = '### Related Information\n\n';

    results.forEach((result, index) => {
      markdown += `#### Source: ${result.source}\n\n`;
      markdown += `${result.text}\n\n`;
      markdown += `*Relevance Score: ${(result.score * 100).toFixed(2)}%*\n\n`;
      if (index < results.length - 1) {
        markdown += '---\n\n';
      }
    });

    return markdown;
  }

  // streamResponse method removed as we're now sending the complete response at once

  private async generateModelResponse(
    message: string,
    searchResults: SearchResult[],
    modelId: string,
    provider: string,
    apiKey: string
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
        .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
        .join('\n\n');

      const modelWorker = new Worker(workerPath, {
        workerData: {
          prompt: message,
          searchResults,
          modelId: modelId ?? this.currentModel,
          chatHistory: formattedChatHistory,
          provider: provider,
          apiKey: apiKey
        },
      });

      return new Promise((resolve, reject) => {
        modelWorker.on(
          'message',
          (result: {
            type: string;
            content?: string;
            message?: string;
            progress?: string;
          }) => {
            switch (result.type) {
              case WORKER_STATUS.PROCESSING:
                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS,
                  progress: result.progress,
                });
                break;
            }
            if (result.type === 'error') {
              reject(new Error(result.message));
            } else {
              resolve(result.content ?? 'No response generated');
            }
            modelWorker.terminate();
          }
        );

        modelWorker.on('error', (error) => {
          reject(error);
          modelWorker.terminate();
        });
      });
    } catch (error) {
      console.error('Error in model inference:', error);
      throw error;
    }
  }
}
