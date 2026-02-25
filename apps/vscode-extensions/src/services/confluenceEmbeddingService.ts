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
        execArgv: ['--inspect=9229'], // Enable debugging on port 9229
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
      const { embeddingDirPath, processPath } =
        await this.getConfluenceMDAndEmbeddingPath('searchProcess.js');

      const workerData = {
        query,
        embeddingDirPath,
      };

      const searchProcess = fork(processPath, [], {
        env: {
          workerData: JSON.stringify(workerData),
        },
        execArgv: ['--max-old-space-size=4096', '--inspect=9229'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc']
      });

      return new Promise((resolve, reject) => {
        let isResolved = false;

        // Set up timeout
        const timeout = setTimeout(() => {
          if (!isResolved) {
            isResolved = true;
            console.error('Search process timeout');
            searchProcess.kill();
            reject(new Error('Search process timeout after 30 seconds'));
          }
        }, 30000); // 30 second timeout

        searchProcess.on('message', (message: EmbeddingSearchMessage) => {
          if (isResolved) return;

          clearTimeout(timeout);
          isResolved = true;

          if (message.type === 'results') {
            console.log(`Search completed with ${message.data?.length || 0} results`);
            resolve(message.data || []);
          } else if (message.type === 'error') {
            console.error('Search process returned error:', message.message);
            reject(new Error(message.message || 'Unknown error'));
          }
          searchProcess.kill();
        });

        searchProcess.on('error', (error) => {
          if (isResolved) return;

          clearTimeout(timeout);
          isResolved = true;
          console.error('Search process error:', error);
          reject(error);
          searchProcess.kill();
        });

        searchProcess.on('exit', (code, signal) => {
          if (isResolved) return;

          clearTimeout(timeout);
          isResolved = true;

          if (code !== 0) {
            console.error(`Search process exited with code ${code}, signal ${signal}`);
            reject(new Error(`Search process exited with code ${code}`));
          } else {
            // Process exited normally but didn't send a message
            console.warn('Search process exited without sending results');
            resolve([]);
          }
        });

        // Log stderr for debugging
        // searchProcess.stderr?.on('data', (data) => {
        //   data = data.toString()
        //   console.error('Search process stderr:', data);
        // });

        // searchProcess.stdout?.on('data', (data) => {
        //   data = data.toString()
        //   console.log('Search process stdout:', data);
        // });
      });
    } catch (error) {
      console.error('Error in embedding search:', error);
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

  private handleError(error: unknown) {
    console.error('Error starting embedding process:', error);
    this.webviewView?.webview.postMessage({
      type: MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    this.stopEmbeddingProcess();
  }

  private async handleCreateEmbeddingMessage(message: any) {
    // const message = JSON.parse(data ?? 'null');

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
