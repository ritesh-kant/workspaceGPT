import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fork, ChildProcess } from 'child_process';
import { EmbeddingConfig } from 'src/types/types';
import { WORKER_STATUS, MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';

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
  private embeddingProcess: ChildProcess | null = null;
  private searchWorker: ChildProcess | null = null;
  private searchWorkerReady: boolean = false;
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

  private async saveEmbeddingProgress(
    progress: EmbeddingProgress
  ): Promise<void> {
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

  public async createEmbeddings(
    config: EmbeddingConfig,
    resume: boolean = false
  ): Promise<void> {
    try {
      // Stop any existing process
      this.stopEmbeddingProcess();

      // Load the current progress if resuming
      if (resume && this.embeddingProgress) {
        console.log(
          `Resuming embedding from ${this.embeddingProgress.processedFiles}/${this.embeddingProgress.totalFiles} files`
        );
      } else {
        // Reset progress if not resuming
        this.embeddingProgress = {
          processedFiles: 0,
          totalFiles: 0,
          isComplete: false,
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
        'confluence',
        'embeddings'
      );

      // Ensure embedding directory exists
      await ensureDirectoryExists(embeddingDirPath);

      // Delete old data directory if not resuming
      await deleteDirectory(embeddingDirPath);

      // Create a new child process
      const processPath = path.join(
        __dirname,
        'workers',
        'confluence',
        'confluenceEmbeddingProcess.js'
      );
      const workerData = {
        mdDirPath,
        embeddingDirPath,
        config,
        resume: resume,
        lastProcessedFile: this.embeddingProgress?.lastProcessedFile,
        processedFiles: this.embeddingProgress?.processedFiles || 0,
      };
      this.embeddingProcess = fork(processPath, [JSON.stringify(workerData)], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: process.execArgv.filter((arg) => !arg.includes('--inspect')), // Remove any existing inspect arguments
      });

      // Handle messages from the process
      this.embeddingProcess.on('message', async (data) => {
        const message = JSON.parse(data.toString());
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
              isComplete: false,
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
              isComplete: true,
            };
            await this.saveEmbeddingProgress(this.embeddingProgress);

            // this.stopEmbeddingProcess();
            break;
        }
      });

      this.embeddingProcess.on('error', (data) => {
        console.error(`Embedding process stderr: ${data}`);
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
          message: data.toString(),
        });
      });

      // Handle process exit
      // this.embeddingProcess.on('exit', (code) => {
      //   if (code && code !== 0) {
      //     console.error(`Embedding process exited with code ${code}`);
      //     this.webviewView.webview.postMessage({
      //       type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
      //       message: `Embedding process exited with code ${code}`,
      //     });
      //   }
      //   this.embeddingProcess = null;
      // });

      this.embeddingProcess.on('error', (error) => {
        console.error('Embedding process error:', error);
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
          message: error.message,
        });
        this.embeddingProcess = null;
      });
    } catch (error) {
      console.error('Error starting embedding process:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopEmbeddingProcess();
    }
  }

  public async ensureSearchWorker(): Promise<void> {
    if (this.searchWorker && this.searchWorkerReady) {
      return;
    }

    const processPath = path.join(
      __dirname,
      'workers',
      'common',
      'searchProcess.js'
    );
    const embeddingDirPath = path.join(
      this.context.globalStorageUri.fsPath,
      'confluence',
      'embeddings'
    );

    this.searchWorker = fork(processPath, [], {
      execArgv: ['--max-old-space-size=4096'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.searchWorker.on('exit', (code, signal) => {
      console.log(`Confluence search worker exited (code=${code}, signal=${signal})`);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    this.searchWorker.on('error', (error) => {
      console.error('Confluence search worker error:', error);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Confluence search worker init timeout after 30 seconds'));
        this.stopSearchWorker();
      }, 30000);

      const onMessage = (message: any) => {
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.searchWorkerReady = true;
          resolve();
        } else if (message.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(message.message || 'Confluence search worker init error'));
        }
        this.searchWorker?.removeListener('message', onMessage);
      };

      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({ type: 'init', embeddingDirPath, namespace: 'CONFLUENCE' });
    });

    console.log('Confluence search worker initialized and ready.');
  }

  private stopSearchWorker(): void {
    if (this.searchWorker) {
      this.searchWorker.kill();
      this.searchWorker = null;
      this.searchWorkerReady = false;
    }
  }

  public async searchEmbeddings(query: string): Promise<SearchResult[]> {
    try {
      await this.ensureSearchWorker();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error('Confluence Search timeout');
          reject(new Error('Confluence Search timeout after 30 seconds'));
        }, 30000);

        const onMessage = (message: any) => {
          clearTimeout(timeout);
          this.searchWorker?.removeListener('message', onMessage);

          if (message.type === 'results') {
            console.log(`Confluence Search completed with ${message.data?.length || 0} results`);
            
            const taggedData = message.data?.map((o: any) => ({
               ...o,
               data: {
                 ...o.data,
                 sourceName: 'CONFLUENCE' as any
               }
            })) || [];

            resolve(taggedData);
          } else if (message.type === 'error') {
            console.error('Confluence Search error:', message.message);
            reject(new Error(message.message || 'Unknown error'));
          }
        };

        this.searchWorker!.on('message', onMessage);
        this.searchWorker!.send({ type: 'search', query, namespace: 'CONFLUENCE' });
      });
    } catch (error) {
      console.error('Error in Confluence embedding search:', error);
      this.stopSearchWorker();
      throw error;
    }
  }

  private stopEmbeddingProcess(): void {
    if (this.embeddingProcess) {
      this.embeddingProcess.kill();
      this.embeddingProcess = null;
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

}
