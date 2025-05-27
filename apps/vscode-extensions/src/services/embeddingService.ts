import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fork, ChildProcess } from 'child_process';
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
  private embeddingProcess: ChildProcess | null = null;
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
      // Stop any existing process
      this.stopEmbeddingProcess();

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

      // Create a new child process
      const processPath = path.join(__dirname, 'workers', 'confluence', 'confluenceEmbeddingProcess.js');
      const workerData = {
        mdDirPath,
        embeddingDirPath,
        config,
        resume: resume,
        lastProcessedFile: this.embeddingProgress?.lastProcessedFile,
        processedFiles: this.embeddingProgress?.processedFiles || 0
      };
      this.embeddingProcess = fork(processPath, [JSON.stringify(workerData)], { 
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: process.execArgv.filter(arg => !arg.includes('--inspect')) // Remove any existing inspect arguments
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
            
            // this.stopEmbeddingProcess();
            break;
        }
      });

      this.embeddingProcess.on("error", (data) => {
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

  public async searchEmbeddings(query: string): Promise<SearchResult[]> {
    try {
      // Create a new child process for search
      const processPath = path.join(__dirname, 'workers', 'confluence', 'searchProcess.js');
      const workerData = {
        query,
        embeddingDirPath: path.join(
          this.context.globalStorageUri.fsPath,
          'embeddings'
        ),
      };
      const searchProcess = fork(processPath, [JSON.stringify(workerData)], { 
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        execArgv: process.execArgv.filter(arg => !arg.includes('--inspect')) // Remove any existing inspect arguments
      });

      return new Promise((resolve, reject) => {
        let resultsData = '';
        searchProcess.on('message', (data) => {
          resultsData += data.toString();
        });

        searchProcess.on("error", (data) => {
          console.error(`Search process stderr: ${data}`);
          try {
            const errorObj = JSON.parse(data.toString());
            reject(new Error(errorObj.message || 'Search process error'));
          } catch (e) {
            reject(new Error(data.toString()));
          }
          searchProcess.kill();
        });

        searchProcess.on('exit', (code) => {
          if (code === 0) {
            try {
              const results = JSON.parse(resultsData);
              resolve(results);
            } catch (e) {
              reject(new Error('Failed to parse search results.'));
            }
          } else {
            // Error already handled by stderr or 'error' event
            if (!resultsData) { // if no specific error message from stderr
                 reject(new Error(`Search process exited with code ${code}`));
            }
          }
        });

        searchProcess.on('error', (error) => {
          reject(error);
          searchProcess.kill();
        });
      });
    } catch (error) {
      console.error('Error in embedding search:', error);
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
