import * as vscode from 'vscode';
import * as path from 'path';
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

export class AdoEmbeddingService {
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

  public eagerInit(): void {
    this.ensureSearchWorker().catch((err) => {
      console.warn('AdoEmbeddingService: Eager init failed:', err);
    });
  }

  public async ensureSearchWorker(): Promise<void> {
    if (this.searchWorker && this.searchWorkerReady) {
      return; 
    }

    this.stopSearchWorker();

    const { embeddingDirPath, processPath } =
      await this.getAdoMDAndEmbeddingPath('searchProcess.js');

    this.searchWorker = fork(processPath, [], {
      execArgv: ['--max-old-space-size=4096'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.searchWorker.on('exit', (code, signal) => {
      console.log(`ADO search worker exited (code=${code}, signal=${signal})`);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    this.searchWorker.on('error', (error) => {
      console.error('ADO search worker error:', error);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ADO search worker init timeout after 30 seconds'));
        this.stopSearchWorker();
      }, 30000);

      const onMessage = (message: any) => {
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.searchWorkerReady = true;
          resolve();
        } else if (message.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(message.message || 'ADO search worker init error'));
        }
        this.searchWorker?.removeListener('message', onMessage);
      };

      const embeddingSettings = getEmbeddingSettings(this.context);
      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({
        type: 'init',
        embeddingDirPath,
        namespace: 'ADO',
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: getVectorStoreSettings(this.context),
      });
    });

    console.log('ADO search worker initialized and ready.');
  }

  private stopSearchWorker(): void {
    if (this.searchWorker) {
      this.searchWorker.kill();
      this.searchWorker = null;
      this.searchWorkerReady = false;
    }
  }

  private async reloadSearchWorkerEmbeddings(): Promise<void> {
    if (!this.searchWorker || !this.searchWorkerReady) {
      return;
    }

    const { embeddingDirPath } =
      await this.getAdoMDAndEmbeddingPath('searchProcess.js');

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('ADO search worker reload timeout, will reload on next search.');
        resolve();
      }, 15000);

      const onMessage = (message: any) => {
        if (message.type === 'reloaded') {
          clearTimeout(timeout);
          console.log('ADO search worker embeddings reloaded.');
          resolve();
        }
        this.searchWorker?.removeListener('message', onMessage);
      };

      const embeddingSettings = getEmbeddingSettings(this.context);
      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({
        type: 'reload',
        embeddingDirPath,
        namespace: 'ADO',
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: getVectorStoreSettings(this.context),
      });
    });
  }

  public async createEmbeddings(
    config: EmbeddingConfig,
    resume: boolean = false
  ) {
    try {
      await this.stopEmbeddingProcess();
      await this.resetStateIfNotResume(resume);

      // Inject the active embedding provider/key so the worker embeds with the
      // user's selection (local ONNX by default, Gemini when configured).
      const embeddingSettings = getEmbeddingSettings(this.context);
      const vectorStoreSettings = getVectorStoreSettings(this.context);
      console.log(
        '[workspaceGPT][ado] starting embedding sync with resolved settings: ' +
          `embedding.provider=${embeddingSettings.provider}, ` +
          `vectorStore.location=${vectorStoreSettings.location}, ` +
          `qdrantUrl=${vectorStoreSettings.qdrantUrl || '(none)'}, ` +
          `qdrantApiKey=${vectorStoreSettings.qdrantApiKey ? 'set' : '(none)'}`,
      );
      if (vectorStoreSettings.location !== 'cloud') {
        console.warn(
          '[workspaceGPT][ado] vectorStore.location is NOT "cloud" — ' +
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
        await this.getAdoMDAndEmbeddingPath('createEmbeddingForText.js');

      const { workerData } = this.createWorkerData(
        mdDirPath,
        embeddingDirPath,
        config,
        resume
      );

      this.embeddingProcess = fork(processPath, [], {
        // ONNX inference allocates well past the default heap on larger
        // batches; without this the worker is OOM-killed mid-run.
        execArgv: ['--max-old-space-size=4096'],
        env: {
          ...process.env,
          workerData: JSON.stringify(workerData),
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      // Forward the worker's stdout/stderr to the extension host console so the
      // [workspaceGPT][embedding] / [workspaceGPT][qdrant] diagnostics are visible.
      this.embeddingProcess.stdout?.on('data', (chunk) =>
        process.stdout.write(`[ado-embed-worker] ${chunk}`)
      );
      this.embeddingProcess.stderr?.on('data', (chunk) =>
        process.stderr.write(`[ado-embed-worker] ${chunk}`)
      );

      this.embeddingProcess.on('message', async (data) => {
        await this.handleCreateEmbeddingMessage(data);
      });

      this.embeddingProcess.on('error', (error) => {
        this.handleError(error);
      });

      // 'error' only fires on spawn/send failure — a child that crashes or is
      // OOM-killed mid-batch emits 'exit' instead. Without this, that death is
      // completely silent and the UI sits at the last reported percentage
      // forever, which is indistinguishable from a hang.
      const startedProcess = this.embeddingProcess;
      startedProcess.on('exit', (code, signal) => {
        if (this.embeddingProcess !== startedProcess) {
          return; // superseded by a newer run, or stopped deliberately
        }
        this.embeddingProcess = null;
        if (code === 0) {
          return;
        }
        const reason = signal
          ? `killed by signal ${signal}`
          : `exited with code ${code}`;
        console.error(`ADO embedding worker died unexpectedly: ${reason}`);
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
          message: `Indexing stopped: the embedding worker ${reason}.`,
        });
      });
    } catch (error) {
      this.handleError(error);
    }
  }

  public async searchEmbeddings(
    query: string,
    topK?: number
  ): Promise<EmbeddingSearchResult[]> {
    try {
      await this.ensureSearchWorker();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error('ADO Search timeout');
          reject(new Error('ADO Search timeout after 30 seconds'));
        }, 30000);

        const onMessage = (message: EmbeddingSearchMessage) => {
          clearTimeout(timeout);
          this.searchWorker?.removeListener('message', onMessage);

          if (message.type === 'results') {
            console.log(`ADO Search completed with ${message.data?.length || 0} results`);

            const taggedData: EmbeddingSearchResult[] = message.data?.map((o) => ({
              ...o,
              data: {
                ...o.data,
                sourceName: 'ADO' as const,
              },
            })) || [];

            resolve(taggedData);
          } else if (message.type === 'error') {
            console.error('ADO Search error:', message.message);
            reject(new Error(message.message || 'Unknown error'));
          }
        };

        this.searchWorker!.on('message', onMessage);
        this.searchWorker!.send({ type: 'search', query, topK, namespace: 'ADO' });
      });
    } catch (error) {
      console.error('Error in ADO embedding search:', error);
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
      await this.getAdoMDAndEmbeddingPath('searchProcess.js');
    await deleteDirectory(embeddingDirPath);
  }

  /**
   * Kills the embedding child process and waits for it to actually exit
   * before resolving. A bare `.kill()` returns immediately — the child is
   * almost always mid-batch (blocked in synchronous ONNX inference, or
   * mid-checkpoint writing embeddings.bin/embeddings_meta.json) when this is
   * called, so without waiting, createEmbeddings() would fork a *second*
   * process against the same files while the first is still alive: both
   * write the same embeddings.bin/embeddings_meta.json concurrently (a torn
   * write corrupts entries silently — Float32Array.slice doesn't throw on a
   * truncated buffer), and the dying process's stray 'message' events can
   * overwrite this.embeddingProgress with stale numbers after the new
   * process has already moved further.
   */
  public stopEmbeddingProcess(): Promise<void> {
    const proc = this.embeddingProcess;
    this.embeddingProcess = null;
    if (!proc) {
      return Promise.resolve();
    }
    proc.removeAllListeners('message');
    proc.removeAllListeners('error');
    return new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
      proc.kill();
    });
  }

  public async dispose(): Promise<void> {
    await this.stopEmbeddingProcess();
    this.stopSearchWorker();
  }

  private handleError(error: unknown) {
    console.error('Error starting ADO embedding process:', error);
    this.webviewView?.webview.postMessage({
      type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    this.stopEmbeddingProcess();
  }

  private async handleCreateEmbeddingMessage(message: any) {
    switch (message.type) {
      case WORKER_STATUS.PROCESSING:
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_ADO_IN_PROGRESS,
          progress: message.progress,
          current: message.current,
          total: message.total,
        });
        await this.saveEmbeddingState(message);
        break;

      case WORKER_STATUS.ERROR:
        console.error(`ADO Worker error: ${message.message}`);
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
          message: message.message,
        });
        break;

      case WORKER_STATUS.COMPLETED:
        console.log('ADO Embedding creation complete');
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.INDEXING_ADO_COMPLETE,
        });
        await this.saveEmbeddingProgress(message);
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
      debug: vscode.workspace
        .getConfiguration('workspacegpt')
        .get<boolean>('debugIndexing', false),
    };
    return { workerData };
  }

  private async getAdoMDAndEmbeddingPath(processName: string) {
    const mdDirPath = path.join(
      this.context.globalStorageUri.fsPath,
      'ado',
      'mds'
    );
    const embeddingDirPath = path.join(
      this.context.globalStorageUri.fsPath,
      'ado',
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
