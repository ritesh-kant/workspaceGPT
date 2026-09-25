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
import { postToWebview } from 'src/utils/webviewBroadcast';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';
import { getEmbeddingSettings } from 'src/utils/getEmbeddingSettings';
import { getVectorStoreSettings } from 'src/utils/getVectorStoreSettings';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { publishSyncState } from 'src/utils/syncStateStore';

/**
 * Indexing into the 'JIRA' namespace — mirrors AdoEmbeddingService exactly,
 * reusing the SAME generic workers/common/{createEmbeddingForText,
 * searchProcess}.js (namespace-parameterized already; see
 * docs/design/jira.md §5 P5 — this is the piece the design doc calls
 * "reused unchanged").
 */
export class JiraEmbeddingService {
  // One indexing worker per source per host. The sync scheduler and the settings
  // panel each build their own instance, and Stop has to reach whichever run
  // is live; two runs would also write the same files.
  private static activeEmbeddingProcess: ChildProcess | null = null;
  private get embeddingProcess(): ChildProcess | null {
    return JiraEmbeddingService.activeEmbeddingProcess;
  }
  private set embeddingProcess(value: ChildProcess | null) {
    JiraEmbeddingService.activeEmbeddingProcess = value;
  }
  // The run this instance forked, so dispose() only ends its own.
  private startedHere: ChildProcess | null = null;
  private searchWorker: ChildProcess | null = null;
  private searchWorkerReady: boolean = false;
  private webviewView?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private embeddingProgress?: EmbeddingProgress;

  /**
   * The scheduler's instance has no webview of its own. Its progress and
   * completion still have to reach the panel, or a background or resumed run
   * reads as "Not synced yet" or "Indexing… 0%" while it is working.
   */
  private post(message: unknown): void {
    if (this.webviewView) {
      this.webviewView.webview.postMessage(message);
    } else {
      postToWebview(message);
    }
  }

  constructor(webviewView: vscode.WebviewView | undefined, context: vscode.ExtensionContext) {
    this.webviewView = webviewView;
    this.context = context;
    this.loadEmbeddingProgress();
  }

  private loadEmbeddingProgress() {
    const progress = this.context.globalState.get<EmbeddingProgress>(STORAGE_KEYS.JIRA_EMBEDDING_PROGRESS);
    this.embeddingProgress = progress;
  }

  private async saveEmbeddingProgress(progress: EmbeddingProgress) {
    await this.context.globalState.update(STORAGE_KEYS.JIRA_EMBEDDING_PROGRESS, progress);
    this.embeddingProgress = progress;
  }

  public eagerInit(): void {
    this.ensureSearchWorker().catch((err) => {
      console.warn('JiraEmbeddingService: Eager init failed:', err);
    });
  }

  public async ensureSearchWorker(): Promise<void> {
    if (this.searchWorker && this.searchWorkerReady) {
      return;
    }

    this.stopSearchWorker();

    const { embeddingDirPath, processPath } = await this.getJiraMDAndEmbeddingPath('searchProcess.js');

    this.searchWorker = fork(processPath, [], {
      execArgv: ['--max-old-space-size=4096'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    this.searchWorker.on('exit', (code, signal) => {
      console.log(`Jira search worker exited (code=${code}, signal=${signal})`);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    this.searchWorker.on('error', (error) => {
      console.error('Jira search worker error:', error);
      this.searchWorker = null;
      this.searchWorkerReady = false;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Jira search worker init timeout after 30 seconds'));
        this.stopSearchWorker();
      }, 30000);

      const onMessage = (message: any) => {
        if (message.type === 'ready') {
          clearTimeout(timeout);
          this.searchWorkerReady = true;
          resolve();
        } else if (message.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(message.message || 'Jira search worker init error'));
        }
        this.searchWorker?.removeListener('message', onMessage);
      };

      const embeddingSettings = getEmbeddingSettings(this.context);
      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({
        type: 'init',
        embeddingDirPath,
        namespace: 'JIRA',
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: getVectorStoreSettings(this.context),
      });
    });

    console.log('Jira search worker initialized and ready.');
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

    const { embeddingDirPath } = await this.getJiraMDAndEmbeddingPath('searchProcess.js');

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('Jira search worker reload timeout, will reload on next search.');
        resolve();
      }, 15000);

      const onMessage = (message: any) => {
        if (message.type === 'reloaded') {
          clearTimeout(timeout);
          console.log('Jira search worker embeddings reloaded.');
          resolve();
        }
        this.searchWorker?.removeListener('message', onMessage);
      };

      const embeddingSettings = getEmbeddingSettings(this.context);
      this.searchWorker!.on('message', onMessage);
      this.searchWorker!.send({
        type: 'reload',
        embeddingDirPath,
        namespace: 'JIRA',
        provider: embeddingSettings.provider,
        apiKey: embeddingSettings.apiKey,
        apiKeys: embeddingSettings.apiKeys,
        vectorStore: getVectorStoreSettings(this.context),
      });
    });
  }

  public async createEmbeddings(config: EmbeddingConfig, resume: boolean = false) {
    try {
      await this.stopEmbeddingProcess();
      // Re-read: another instance (scheduler or panel) may have advanced it.
      this.loadEmbeddingProgress();
      await this.resetStateIfNotResume(resume);

      const embeddingSettings = getEmbeddingSettings(this.context);
      const vectorStoreSettings = getVectorStoreSettings(this.context);
      console.log(
        '[workspaceGPT][jira] starting embedding sync with resolved settings: ' +
          `embedding.provider=${embeddingSettings.provider}, ` +
          `vectorStore.location=${vectorStoreSettings.location}, ` +
          `qdrantUrl=${vectorStoreSettings.qdrantUrl || '(none)'}, ` +
          `qdrantApiKey=${vectorStoreSettings.qdrantApiKey ? 'set' : '(none)'}`,
      );
      if (vectorStoreSettings.location !== 'cloud') {
        console.warn(
          '[workspaceGPT][jira] vectorStore.location is NOT "cloud" — ' +
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

      const { embeddingDirPath, mdDirPath, processPath } = await this.getJiraMDAndEmbeddingPath(
        'createEmbeddingForText.js'
      );

      const { workerData } = this.createWorkerData(mdDirPath, embeddingDirPath, config, resume);

      this.embeddingProcess = fork(processPath, [], {
        execArgv: ['--max-old-space-size=4096'],
        env: {
          ...process.env,
          workerData: JSON.stringify(workerData),
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      this.startedHere = this.embeddingProcess;

      this.embeddingProcess.stdout?.on('data', (chunk) => process.stdout.write(`[jira-embed-worker] ${chunk}`));
      this.embeddingProcess.stderr?.on('data', (chunk) => process.stderr.write(`[jira-embed-worker] ${chunk}`));

      this.embeddingProcess.on('message', async (data) => {
        await this.handleCreateEmbeddingMessage(data);
      });

      this.embeddingProcess.on('error', async (error) => {
        await this.handleError(error);
      });

      const startedProcess = this.embeddingProcess;
      startedProcess.on('exit', async (code, signal) => {
        if (this.embeddingProcess !== startedProcess) {
          return;
        }
        this.embeddingProcess = null;
        if (code === 0) {
          return;
        }
        const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
        console.error(`Jira embedding worker died unexpectedly: ${reason}`);
        await publishSyncState(this.context, 'jira', { isIndexing: false });
        this.post({
          type: MESSAGE_TYPES.INDEXING_JIRA_ERROR,
          message: `Indexing stopped: the embedding worker ${reason}.`,
        });
      });
    } catch (error) {
      await this.handleError(error);
    }
  }

  public async searchEmbeddings(query: string, topK?: number): Promise<EmbeddingSearchResult[]> {
    try {
      await this.ensureSearchWorker();

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error('Jira search timeout');
          reject(new Error('Jira search timeout after 30 seconds'));
        }, 30000);

        const onMessage = (message: EmbeddingSearchMessage) => {
          clearTimeout(timeout);
          this.searchWorker?.removeListener('message', onMessage);

          if (message.type === 'results') {
            console.log(`Jira search completed with ${message.data?.length || 0} results`);

            const taggedData: EmbeddingSearchResult[] = message.data?.map((o) => ({
              ...o,
              data: {
                ...o.data,
                sourceName: 'JIRA' as const,
              },
            })) || [];

            resolve(taggedData);
          } else if (message.type === 'error') {
            console.error('Jira search error:', message.message);
            reject(new Error(message.message || 'Unknown error'));
          }
        };

        this.searchWorker!.on('message', onMessage);
        this.searchWorker!.send({ type: 'search', query, topK, namespace: 'JIRA' });
      });
    } catch (error) {
      console.error('Error in Jira embedding search:', error);
      this.stopSearchWorker();
      throw error;
    }
  }

  public getEmbeddingProgress() {
    return this.embeddingProgress;
  }

  public async resetEmbeddingProgress() {
    this.embeddingProgress = undefined;
    await this.context.globalState.update(STORAGE_KEYS.JIRA_EMBEDDING_PROGRESS, undefined);
  }

  public async clearEmbeddingIndex(): Promise<void> {
    this.stopSearchWorker();
    const { embeddingDirPath } = await this.getJiraMDAndEmbeddingPath('searchProcess.js');
    await deleteDirectory(embeddingDirPath);
  }

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
    // The indexing worker is shared across instances. The chat service's
    // search-only instances are disposed with the panel and on reset, and
    // must not end a scheduler's run.
    if (this.embeddingProcess && this.embeddingProcess === this.startedHere) {
      await this.stopEmbeddingProcess();
    }
    this.stopSearchWorker();
  }

  private async handleError(error: unknown) {
    console.error('Error starting Jira embedding process:', error);
    await publishSyncState(this.context, 'jira', { isIndexing: false });
    this.post({
      type: MESSAGE_TYPES.INDEXING_JIRA_ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    await this.stopEmbeddingProcess();
  }

  private async handleCreateEmbeddingMessage(message: any) {
    switch (message.type) {
      case WORKER_STATUS.PROCESSING:
        this.post({
          type: MESSAGE_TYPES.INDEXING_JIRA_IN_PROGRESS,
          progress: message.progress,
          current: message.current,
          total: message.total,
        });
        await this.saveEmbeddingState(message);
        break;

      case WORKER_STATUS.ERROR:
        console.error(`Jira worker error: ${message.message}`);
        await publishSyncState(this.context, 'jira', { isIndexing: false });
        this.post({
          type: MESSAGE_TYPES.INDEXING_JIRA_ERROR,
          message: message.message,
        });
        break;

      case WORKER_STATUS.COMPLETED:
        console.log('Jira embedding creation complete');
        // Written here, not by the webview on INDEXING_*_COMPLETE: a scheduler
        // run may finish with no panel open, and chat only searches a source
        // whose index is marked complete.
        await publishSyncState(this.context, 'jira', {
          isIndexing: false,
          isIndexingCompleted: true,
        });
        this.post({
          type: MESSAGE_TYPES.INDEXING_JIRA_COMPLETE,
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

  private createWorkerData(mdDirPath: string, embeddingDirPath: string, config: EmbeddingConfig, resume: boolean) {
    const workerData = {
      mdDirPath,
      embeddingDirPath,
      config,
      resume,
      lastProcessedFile: this.embeddingProgress?.lastProcessedFile,
      processedFiles: this.embeddingProgress?.processedFiles || 0,
      debug: vscode.workspace.getConfiguration('workspacegpt').get<boolean>('debugIndexing', false),
    };
    return { workerData };
  }

  private async getJiraMDAndEmbeddingPath(processName: string) {
    const mdDirPath = path.join(this.context.globalStorageUri.fsPath, 'jira', 'mds');
    const embeddingDirPath = path.join(this.context.globalStorageUri.fsPath, 'jira', 'embeddings');
    const processPath = path.join(__dirname, 'workers', 'common', processName);
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
