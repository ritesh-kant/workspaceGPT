import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fork, ChildProcess } from 'child_process';
import {
  EmbeddingConfig,
  EmbeddingProgress,
  EmbeddingSearchMessage,
  EmbeddingSearchResult,
} from 'src/types/types';
import { WORKER_STATUS, MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';

export class EmbeddingService {
  private embeddingProcess: ChildProcess | null = null;
  private searchWorker: ChildProcess | null = null;
  private searchWorkerReady: boolean = false;
  private webviewView?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private embeddingProgress?: EmbeddingProgress;

  constructor(
    webviewView: vscode.WebviewView | undefined,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.loadEmbeddingProgress();
  }

  private loadEmbeddingProgress() {
    const progress = this.context.globalState.get<EmbeddingProgress>(
      STORAGE_KEYS.EMBEDDING_PROGRESS
    );
    this.embeddingProgress = progress;
  }

  private async saveEmbeddingProgress(progress: EmbeddingProgress) {
    await this.context.globalState.update(
      STORAGE_KEYS.EMBEDDING_PROGRESS,
      progress
    );
    this.embeddingProgress = progress;
  }

  /**
   * Eagerly initialize the search worker in the background.
   * Call this on extension activation so the first query is fast.
   */
  public eagerInit(): void {
    // Fire-and-forget: spawn the worker in the background
    this.ensureSearchWorker().catch((err) => {
      console.warn('EmbeddingService: Eager init failed (will retry on first search):', err);
    });
  }

  // ── Persistent Search Worker Management ────────────────────────────

  /**
   * Lazily spawns a persistent search worker and initializes it.
   * The worker stays alive across queries — no more per-query model init.
   */
  private async ensureSearchWorker(): Promise<void> {
    if (this.searchWorker && this.searchWorkerReady) {
      return; // Already running and ready
    }

    // Kill any stale worker
    this.stopSearchWorker();

    const { embeddingDirPath, processPath } =
      await this.getConfluenceMDAndEmbeddingPath('searchProcess.js');

    this.searchWorker = fork(processPath, [], {
      execArgv: ['--max-old-space-size=4096'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    // Handle unexpected exits — mark as not ready so next search re-spawns
    this.searchWorker.on('exit', (code, signal) => {
      console.log(`Search worker exited (code=${code}, signal=${signal})`);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    this.searchWorker.on('error', (error) => {
      console.error('Search worker error:', error);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    // Send init message and wait for 'ready'
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Search worker init timeout after 30 seconds'));
        this.stopSearchWorker();
      }, 30000);

      const onMessage = (message: any) => {
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.searchWorkerReady = true;
          resolve();
        } else if (message.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(message.message || 'Search worker init error'));
        }
        // Remove this one-time listener; searchEmbeddings will set its own
        this.searchWorker?.removeListener('message', onMessage);
      };

      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({ type: 'init', embeddingDirPath });
    });

    console.log('Search worker initialized and ready.');
  }

  private stopSearchWorker(): void {
    if (this.searchWorker) {
      this.searchWorker.kill();
      this.searchWorker = null;
      this.searchWorkerReady = false;
    }
  }

  /**
   * Tell the persistent search worker to reload embeddings from disk.
   * Called after embedding creation completes.
   */
  private async reloadSearchWorkerEmbeddings(): Promise<void> {
    if (!this.searchWorker || !this.searchWorkerReady) {
      return; // Worker not running; next search will load fresh data
    }

    const { embeddingDirPath } =
      await this.getConfluenceMDAndEmbeddingPath('searchProcess.js');

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('Search worker reload timeout, will reload on next search.');
        resolve();
      }, 15000);

      const onMessage = (message: any) => {
        if (message.type === 'reloaded') {
          clearTimeout(timeout);
          console.log('Search worker embeddings reloaded.');
          resolve();
        }
        this.searchWorker?.removeListener('message', onMessage);
      };

      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({ type: 'reload', embeddingDirPath });
    });
  }

  // ── Public API ─────────────────────────────────────────────────────

  public async createEmbeddings(
    config: EmbeddingConfig,
    resume: boolean = false
  ) {
    try {
      this.stopEmbeddingProcess();

      await this.resetStateIfNotResume(resume);

      const { embeddingDirPath, mdDirPath, processPath } =
        await this.getConfluenceMDAndEmbeddingPath('createEmbeddingForText.js');

      // Create a new child process
      const { workerData } = this.createWorkerData(
        mdDirPath,
        embeddingDirPath,
        config,
        resume
      );

      this.embeddingProcess = fork(processPath, [], {
        env: {
          workerData: JSON.stringify(workerData),
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      // Handle messages from the process
      this.embeddingProcess.on('message', async (data) => {
        await this.handleCreateEmbeddingMessage(data);
      });

      this.embeddingProcess.on('error', (error) => {
        this.handleError(error);
      });
    } catch (error) {
      this.handleError(error);
    }
  }

  public async searchEmbeddings(
    query: string
  ): Promise<EmbeddingSearchResult[]> {
    try {
      // Ensure the persistent search worker is running
      await this.ensureSearchWorker();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error('Search timeout');
          reject(new Error('Search timeout after 30 seconds'));
        }, 30000);

        const onMessage = (message: EmbeddingSearchMessage) => {
          clearTimeout(timeout);
          this.searchWorker?.removeListener('message', onMessage);

          if (message.type === 'results') {
            console.log(`Search completed with ${message.data?.length || 0} results`);
            resolve(message.data || []);
          } else if (message.type === 'error') {
            console.error('Search error:', message.message);
            reject(new Error(message.message || 'Unknown error'));
          }
        };

        this.searchWorker!.on('message', onMessage);
        this.searchWorker!.send({ type: 'search', query });
      });
    } catch (error) {
      console.error('Error in embedding search:', error);
      // If the worker crashed, reset so it re-spawns on next search
      this.stopSearchWorker();
      throw error;
    }
  }

  public getEmbeddingProgress() {
    return this.embeddingProgress;
  }

  public async resetEmbeddingProgress() {
    this.embeddingProgress = undefined;
    await this.context.globalState.update(
      STORAGE_KEYS.EMBEDDING_PROGRESS,
      undefined
    );
  }

  // Util functions
  public stopEmbeddingProcess(): void {
    if (this.embeddingProcess) {
      this.embeddingProcess.kill();
      this.embeddingProcess = null;
    }
  }

  /**
   * Clean up all child processes. Call this on extension deactivation.
   */
  public dispose(): void {
    this.stopEmbeddingProcess();
    this.stopSearchWorker();
  }

  private handleError(error: unknown) {
    console.error('Error starting embedding process:', error);
    this.webviewView?.webview.postMessage({
      type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    this.stopEmbeddingProcess();
  }

  private async handleCreateEmbeddingMessage(message: any) {
    switch (message.type) {
      case WORKER_STATUS.PROCESSING:
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS,
          progress: message.progress,
          current: message.current,
          total: message.total,
        });
        await this.saveEmbeddingState(message);
        break;

      case WORKER_STATUS.ERROR:
        console.error(`Worker error: ${message.message}`);
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
          message: message.message,
        });
        break;

      case WORKER_STATUS.COMPLETED:
        console.log('Embedding creation complete');
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE,
        });
        await this.saveEmbeddingProgress(message);
        // Notify the search worker to reload embeddings from disk
        await this.reloadSearchWorkerEmbeddings();
        break;
    }
  }

  private async saveEmbeddingState(message: any) {
    this.embeddingProgress = {
      processedFiles: message.current,
      totalFiles: message.total,
      lastProcessedFile: message.lastProcessedFile,
      isComplete: false,
    };
    await this.saveEmbeddingProgress(this.embeddingProgress);
  }

  private createWorkerData(
    mdDirPath: string,
    embeddingDirPath: string,
    config: EmbeddingConfig,
    resume: boolean
  ) {
    const workerData = {
      mdDirPath,
      embeddingDirPath,
      config,
      resume,
      lastProcessedFile: this.embeddingProgress?.lastProcessedFile,
      processedFiles: this.embeddingProgress?.processedFiles || 0,
    };
    return { workerData };
  }

  private async getConfluenceMDAndEmbeddingPath(processName: string) {
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
    const processPath = path.join(
      __dirname,
      'workers',
      'confluence',
      processName
    );
    await ensureDirectoryExists(embeddingDirPath);

    return { embeddingDirPath, mdDirPath, processPath };
  }

  private async resetStateIfNotResume(resume: boolean) {
    if (!resume) {
      this.embeddingProgress = {
        processedFiles: 0,
        totalFiles: 0,
        isComplete: false,
      };
      await this.saveEmbeddingProgress(this.embeddingProgress);
    }
  }
}
