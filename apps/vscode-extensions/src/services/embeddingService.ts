import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { EmbeddingConfig } from 'src/types/types';
import { WORKER_STATUS, MESSAGE_TYPES } from '../../constants';

interface SearchResult {
  text: string;
  score: number;
  source: string;
}

export class EmbeddingService {
  private worker: Worker | null = null;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;

  constructor(
    webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
  }

  public async createEmbeddings(config: EmbeddingConfig): Promise<void> {
    try {
      // Stop any existing worker
      this.stopWorker();

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
      const workerPath = path.join(__dirname, 'workers', 'embeddingWorker.js');
      this.worker = new Worker(workerPath, {
        workerData: {
          mdDirPath,
          embeddingDirPath,
          config,
        },
      });

      // Handle messages from the worker
      this.worker.on('message', (message) => {
        switch (message.type) {
          case WORKER_STATUS.PROCESSING:
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS,
              progress: message.progress,
              current: message.current,
              total: message.total,
            });
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
      const workerPath = path.join(__dirname, 'workers', 'searchWorker.js');
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
