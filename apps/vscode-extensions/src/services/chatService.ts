import * as vscode from 'vscode';
import { EmbeddingService } from './embeddingService';
import path from 'path';
import { Worker } from 'worker_threads';
import { WORKER_STATUS, MESSAGE_TYPES } from '../../constants';
import { STORAGE_KEYS } from '../../constants';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class ChatService {
  private embeddingService: EmbeddingService;
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
    this.currentModel =
      context.globalState.get(STORAGE_KEYS.MODEL) || STORAGE_KEYS.MODEL;
  }

  public async initializeModel(modelId: string): Promise<void> {
    try {
      const workerPath = path.join(
        __dirname,
        '..',
        'workers',
        'modelWorker.js'
      );
      const modelWorker = new Worker(workerPath, {
        workerData: {
          prompt: '',
          searchResults: [],
          modelId,
          mode: 'initialize',
          globalStoragePath: this.context.globalStorageUri.fsPath, // Pass the path directly
        },
      });

      // Keep track of the last progress update to avoid flooding UI
      let lastProgressUpdate = 0;
      const PROGRESS_UPDATE_THROTTLE = 500; // ms

      return new Promise((resolve, reject) => {
        modelWorker.on(
          'message',
          (result: {
            type: string;
            message?: string;
            progress?: string;
            current?: string;
            total?: string;
          }) => {
            if (result.type === WORKER_STATUS.PROCESSING) {
              const now = Date.now();
              // Only send progress updates at most every PROGRESS_UPDATE_THROTTLE ms
              if (now - lastProgressUpdate > PROGRESS_UPDATE_THROTTLE) {
                lastProgressUpdate = now;

                this.webviewView.webview.postMessage({
                  type: MESSAGE_TYPES.MODEL_DOWNLOAD_IN_PROGRESS,
                  progress: result.progress,
                  current: result.current || '0 MB',
                  total: result.total || '0 MB',
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
      type: 'newChatCreated',
    });
  }

  public async sendMessage(message: string): Promise<void> {
    try {
      // Add user message to history
      this.chatHistory.push({
        role: 'user',
        content: message,
      });

      // Search embeddings
      const searchResults =
        await this.embeddingService.searchEmbeddings(message);

      // Generate response using TinyLlama model
      const modelResponse = await this.generateModelResponse(
        message,
        searchResults
      );

      // Add assistant response to history
      this.chatHistory.push({
        role: 'assistant',
        content: modelResponse,
      });

      // Stream response to webview
      await this.streamResponse(modelResponse);
    } catch (error) {
      console.error('Error in chat:', error);
      this.webviewView.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private formatSearchResults(
    results: { text: string; score: number; source: string }[]
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

  private async streamResponse(content: string): Promise<void> {
    const chunkSize = 50; // Characters per chunk
    const delay = 30; // Milliseconds between chunks

    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      this.webviewView.webview.postMessage({
        type: 'streamResponse',
        content: chunk,
        isComplete: i + chunkSize >= content.length,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private async generateModelResponse(
    message: string,
    searchResults: Array<{ text: string; score: number; source: string }>
  ): Promise<string> {
    try {
      // Create a new worker for model inference
      const workerPath = path.join(
        __dirname,
        '..',
        'workers',
        'modelWorker.js'
      );
      const modelWorker = new Worker(workerPath, {
        workerData: {
          prompt: message,
          searchResults,
          modelId: this.currentModel,
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
              resolve(result.content || 'No response generated');
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
