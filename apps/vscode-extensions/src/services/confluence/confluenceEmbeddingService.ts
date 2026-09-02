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
import { WORKER_STATUS, MESSAGE_TYPES, STORAGE_KEYS } from '../../../constants';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';
import { getEmbeddingSettings } from 'src/utils/getEmbeddingSettings';
import { getVectorStoreSettings } from 'src/utils/getVectorStoreSettings';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { publishSyncState } from 'src/utils/syncStateStore';

export class ConfluenceEmbeddingService {
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
  public async ensureSearchWorker(): Promise<void> {
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

      const embeddingSettings = getEmbeddingSettings(this.context);
      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({
        type: 'init',
        embeddingDirPath,
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: getVectorStoreSettings(this.context),
      });
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

      const embeddingSettings = getEmbeddingSettings(this.context);
      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({
        type: 'reload',
        embeddingDirPath,
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: getVectorStoreSettings(this.context),
      });
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

      // Inject the active embedding provider/key so the worker embeds with the
      // user's selection (local ONNX by default, Gemini when configured).
      const embeddingSettings = getEmbeddingSettings(this.context);
      const vectorStoreSettings = getVectorStoreSettings(this.context);
      console.log(
        '[workspaceGPT][confluence] starting embedding sync with resolved settings: ' +
          `embedding.provider=${embeddingSettings.provider}, ` +
          `vectorStore.location=${vectorStoreSettings.location}, ` +
          `qdrantUrl=${vectorStoreSettings.qdrantUrl || '(none)'}, ` +
          `qdrantApiKey=${vectorStoreSettings.qdrantApiKey ? 'set' : '(none)'}`,
      );
      if (vectorStoreSettings.location !== 'cloud') {
        console.warn(
          '[workspaceGPT][confluence] vectorStore.location is NOT "cloud" — ' +
            'nothing will be written to Qdrant. Set the vector store to Cloud in Settings ' +
            'and re-sync if you expect Qdrant to be populated.',
        );
      }
      config = {
        ...config,
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: vectorStoreSettings,
      };

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

      // Forward the worker's stdout/stderr to the extension host console so the
      // [workspaceGPT][embedding] / [workspaceGPT][qdrant] diagnostics are visible.
      this.embeddingProcess.stdout?.on('data', (chunk) =>
        process.stdout.write(`[confluence-embed-worker] ${chunk}`)
      );
      this.embeddingProcess.stderr?.on('data', (chunk) =>
        process.stderr.write(`[confluence-embed-worker] ${chunk}`)
      );

      // stopEmbeddingProcess() kills without detaching listeners, and a worker
      // blocked in synchronous inference can still emit after a newer run has
      // started. Ignore anything from a process we have already replaced —
      // otherwise its stale COMPLETED clears isIndexing and reports success on
      // behalf of the run that superseded it.
      const startedProcess = this.embeddingProcess;
      const isCurrent = () => this.embeddingProcess === startedProcess;

      // Handle messages from the process
      startedProcess.on('message', async (data) => {
        if (!isCurrent()) return;
        await this.handleCreateEmbeddingMessage(data);
      });

      startedProcess.on('error', async (error) => {
        if (!isCurrent()) return;
        await this.handleError(error);
      });

      // 'error' only fires on spawn/send failure — a worker that crashes or is
      // OOM-killed mid-batch emits 'exit' instead and reports no terminal
      // status of its own. Without this, isIndexing stays set for the rest of
      // the session: checkAndSync skips every tick while indexing is "running",
      // and each webview resolve re-launches indexing.
      startedProcess.on('exit', async (code, signal) => {
        if (!isCurrent()) return; // superseded by a newer run, or stopped deliberately
        this.embeddingProcess = null;
        if (code === 0) {
          return;
        }
        const reason = signal
          ? `killed by signal ${signal}`
          : `exited with code ${code}`;
        console.error(`Confluence embedding worker died unexpectedly: ${reason}`);
        await publishSyncState(this.context, 'confluence', { isIndexing: false });
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
          message: `Indexing stopped: the embedding worker ${reason}.`,
        });
      });
    } catch (error) {
      await this.handleError(error);
    }
  }

  public async searchEmbeddings(
    query: string,
    topK?: number
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
        this.searchWorker!.send({ type: 'search', query, topK });
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

  /**
   * Delete the on-disk embedding index (vectors + manifest + legacy JSON) so
   * the next createEmbeddings() rebuilds it from scratch instead of preserving
   * vectors from a previous sync. Used when the embedding provider changes and
   * the old vectors are no longer compatible with the new provider.
   */
  public async clearEmbeddingIndex(): Promise<void> {
    this.stopSearchWorker();
    const { embeddingDirPath } =
      await this.getConfluenceMDAndEmbeddingPath('searchProcess.js');
    await deleteDirectory(embeddingDirPath);
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

  private async handleError(error: unknown) {
    console.error('Error starting embedding process:', error);
    // Covers the spawn/send failures, where no worker ever runs to report a
    // terminal status — without this isIndexing stays true until the next
    // extension restart clears it.
    await publishSyncState(this.context, 'confluence', { isIndexing: false });
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
        // Clear the persisted flag here, not in the caller: createEmbeddings
        // returns as soon as the worker is forked, so this message is the only
        // point at which indexing is actually known to be over. A background
        // run has no webview to post to, and would otherwise leave isIndexing
        // stuck true — blocking every later scheduled sync until restart.
        await publishSyncState(this.context, 'confluence', { isIndexing: false });
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
          message: message.message,
        });
        break;

      case WORKER_STATUS.COMPLETED:
        console.log('Embedding creation complete');
        await publishSyncState(this.context, 'confluence', { isIndexing: false });
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
      'common',
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
