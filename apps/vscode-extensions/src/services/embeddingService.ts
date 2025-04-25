import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { EmbeddingConfig } from 'src/types/types';
import { WORKER_STATUS, MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';

interface SearchResult {
  text: string;
  score: number;
  source: string;
}

interface EmbeddingProgress {
  processedFiles: number;
  totalFiles: number;
  lastProcessedFile?: string;
  isComplete: boolean;
}

export class EmbeddingService {
  private worker: Worker | null = null;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private embeddingProgress: EmbeddingProgress | null = null;

  constructor(
    webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.loadEmbeddingProgress();
  }

  private async loadEmbeddingProgress(): Promise<void> {
    try {
      const progress = await this.context.globalState.get<EmbeddingProgress>(
        STORAGE_KEYS.EMBEDDING_PROGRESS
      );
      this.embeddingProgress = progress || null;
    } catch (error) {
      console.error('Error loading embedding progress:', error);
      this.embeddingProgress = null;
    }
  }

  private async saveEmbeddingProgress(progress: EmbeddingProgress): Promise<void> {
    try {
      await this.context.globalState.update(
        STORAGE_KEYS.EMBEDDING_PROGRESS,
        progress
      );
      this.embeddingProgress = progress;
    } catch (error) {
      console.error('Error saving embedding progress:', error);
    }
  }

  public async createEmbeddings(config: EmbeddingConfig, resume: boolean = false): Promise<void> {
    try {
      // Stop any existing worker
      this.stopWorker();

      // Load the current progress if resuming
      if (resume && this.embeddingProgress) {
        console.log(`Resuming embedding from ${this.embeddingProgress.processedFiles}/${this.embeddingProgress.totalFiles} files`);
      } else {
        // Reset progress if not resuming
        this.embeddingProgress = {
          processedFiles: 0,
          totalFiles: 0,
          isComplete: false
        };
        await this.saveEmbeddingProgress(this.embeddingProgress);
      }

      // Get the directory path for Confluence MD files
      const mdDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'confluence',
        'mds'
      );
      const embeddingDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'embeddings'
      );

      // Ensure embedding directory exists
      await this.ensureDirectoryExists(embeddingDirPath);

      // Create a new worker
      const workerPath = path.join(__dirname, 'workers', 'confluence', 'embeddingWorker.js');
      this.worker = new Worker(workerPath, {
        workerData: {
          mdDirPath,
          embeddingDirPath,
          config,
          resume: resume,
          lastProcessedFile: this.embeddingProgress?.lastProcessedFile,
          processedFiles: this.embeddingProgress?.processedFiles || 0
        },
      });

      // Handle messages from the worker
      this.worker.on('message', async (message) => {
        switch (message.type) {
          case WORKER_STATUS.PROCESSING:
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS,
              progress: message.progress,
              current: message.current,
              total: message.total,
            });
            
            // Update and save progress
            this.embeddingProgress = {
              processedFiles: message.current,
              totalFiles: message.total,
              lastProcessedFile: message.lastProcessedFile,
              isComplete: false
            };
            await this.saveEmbeddingProgress(this.embeddingProgress);
            break;

          case WORKER_STATUS.ERROR:
            console.error(`Worker error: ${message.message}`);
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
              message: message.message,
            });
            break;

          case WORKER_STATUS.COMPLETED:
            console.log('Embedding creation complete');
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE,
            });
            
            // Update progress as complete
            this.embeddingProgress = {
              processedFiles: message.total,
              totalFiles: message.total,
              isComplete: true
            };
            await this.saveEmbeddingProgress(this.embeddingProgress);
            
            // this.stopWorker();
            break;
        }
      });

      // Handle worker errors
      this.worker.on('error', (error) => {
        console.error('Worker error:', error);
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
          message: error.message,
        });
        this.worker = null;
      });

      // Handle worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker stopped with exit code ${code}`);
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
            message: `Worker process exited with code ${code}`,
          });
        }
        this.worker = null;
      });
    } catch (error) {
      console.error('Error starting worker:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopWorker();
    }
  }

  public async searchEmbeddings(query: string): Promise<SearchResult[]> {
    try {
      // Create a new worker for search
      const workerPath = path.join(__dirname, 'workers', 'confluence','searchWorker.js');
      const searchWorker = new Worker(workerPath, {
        workerData: {
          query,
          embeddingDirPath: path.join(
            this.context.globalStorageUri.fsPath,
            'embeddings'
          ),
        },
      });

      return new Promise((resolve, reject) => {
        searchWorker.on('message', (results: SearchResult[]) => {
          resolve(results);
          searchWorker.terminate();
        });

        searchWorker.on('error', (error) => {
          reject(error);
          searchWorker.terminate();
        });
      });
    } catch (error) {
      console.error('Error in embedding search:', error);
      throw error;
    }
  }

  private stopWorker(): void {
    if (this.worker) {
      this.worker?.terminate();
      this.worker = null;
    }
  }

  public getEmbeddingProgress(): EmbeddingProgress | null {
    return this.embeddingProgress;
  }

  public async resetEmbeddingProgress(): Promise<void> {
    this.embeddingProgress = null;
    await this.context.globalState.update(
      STORAGE_KEYS.EMBEDDING_PROGRESS,
      undefined
    );
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.promises.access(dirPath).catch(async () => {
        await fs.promises.mkdir(dirPath, { recursive: true });
      });
    } catch (error) {
      console.error('Error creating directory:', error);
      throw error;
    }
  }
}
