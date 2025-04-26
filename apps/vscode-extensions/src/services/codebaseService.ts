import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import { EmbeddingConfig } from '../types/types';
import { WORKER_STATUS, MESSAGE_TYPES, STORAGE_KEYS, MODEL } from '../../constants';

interface ProcessedFile {
  filename: string;
  text: string;
  filePath: string;
}

interface CodebaseConfig {
  repoPath: string;
  includePatterns: string;
  excludePatterns: string[];
  maxFileSizeKb: number;
}

interface SyncProgress {
  processedFiles: number;
  totalFiles: number;
  lastProcessedFilePath?: string;
  isComplete: boolean;
}

export class CodebaseService {
  private worker: Worker | null = null;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private syncProgress: SyncProgress | null = null;

  constructor(
    webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.loadSyncProgress();
  }

  private async loadSyncProgress(): Promise<void> {
    try {
      const progress = await this.context.globalState.get<SyncProgress>(
        STORAGE_KEYS.CODEBASE_SYNC_PROGRESS
      );
      this.syncProgress = progress || null;
    } catch (error) {
      console.error('Error loading codebase sync progress:', error);
      this.syncProgress = null;
    }
  }

  private async saveSyncProgress(progress: SyncProgress): Promise<void> {
    try {
      await this.context.globalState.update(
        STORAGE_KEYS.CODEBASE_SYNC_PROGRESS,
        progress
      );
      this.syncProgress = progress;
    } catch (error) {
      console.error('Error saving codebase sync progress:', error);
    }
  }

  async getTotalFiles(config: CodebaseConfig): Promise<number> {
    try {
      // Create a worker to count files
      const workerPath = path.join(__dirname, 'workers', 'codebase','codebaseCountWorker.js');
      const countWorker = new Worker(workerPath, {
        workerData: {
          repoPath: config.repoPath,
          includePatterns: config.includePatterns,
          excludePatterns: [config.excludePatterns],
          maxFileSizeKb: config.maxFileSizeKb
        },
      });

      return new Promise((resolve, reject) => {
        countWorker.on('message', (count: number) => {
          resolve(count);
          countWorker.terminate();
        });

        countWorker.on('error', (error) => {
          reject(error);
          countWorker.terminate();
        });
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('❌ Error counting codebase files:', errorMessage);
      throw error;
    }
  }

  public async startSync(
    config: CodebaseConfig,
    onComplete?: () => Promise<void>,
    resume: boolean = false
  ): Promise<void> {
    try {
      // Stop any existing worker
      this.stopSync();
      const repoName = config?.repoPath.split('/').slice(-1)[0]


      // Load the current progress if resuming
      if (resume && this.syncProgress) {
        console.log(`Resuming codebase sync from ${this.syncProgress.processedFiles}/${this.syncProgress.totalFiles} files`);
      } else {
        // Reset progress if not resuming
        this.syncProgress = {
          processedFiles: 0,
          totalFiles: 0,
          isComplete: false
        };
        await this.saveSyncProgress(this.syncProgress);
      }

      // Create output directories
      const codebaseDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        repoName,
        'codebase',
        'files'
      );
      await this.ensureDirectoryExists(codebaseDirPath);

      // Create a new worker
      const workerPath = path.join(__dirname, 'workers','codebase', 'codebaseWorker.js');
      this.worker = new Worker(workerPath, {
        workerData: {
          repoPath: config.repoPath,
          includePatterns: config.includePatterns,
          excludePatterns: [config.excludePatterns],
          maxFileSizeKb: config.maxFileSizeKb,
          outputDirPath: codebaseDirPath,
          resume: resume,
          lastProcessedFilePath: this.syncProgress?.lastProcessedFilePath,
          processedFiles: this.syncProgress?.processedFiles || 0
        },
      });

      // Handle messages from the worker
      this.worker.on('message', async (message) => {
        switch (message.type) {
          case WORKER_STATUS.PROCESSING:
            // Update progress in the webview
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_CODEBASE_IN_PROGRESS,
              source: 'codebase',
              progress: message.progress,
              current: message.current,
              total: message.total,
            });
            
            // Update and save progress
            this.syncProgress = {
              processedFiles: message.current,
              totalFiles: message.total,
              lastProcessedFilePath: message.lastProcessedFilePath,
              isComplete: false
            };
            await this.saveSyncProgress(this.syncProgress);
            break;

          case WORKER_STATUS.PROCESSED:
            // Save individual processed file
            await this.saveProcessedFile(message.file, repoName);
            break;

          case WORKER_STATUS.ERROR:
            console.error(`Worker error: ${message.message}`);
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
              message: message.message,
            });
            break;

          case WORKER_STATUS.COMPLETED:
            console.log(
              `Codebase sync complete. Processed ${message.files.length} files.`
            );
            // Notify the webview that sync is complete
            // this.webviewView.webview.postMessage({
            //   type: MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE,
            //   source: 'codebase',
            //   filesCount: message.files.length,
            // });

            // Update progress as complete
            this.syncProgress = {
              processedFiles: message.files.length,
              totalFiles: message.files.length,
              isComplete: true
            };
            await this.saveSyncProgress(this.syncProgress);

            // Clean up the worker
            this.stopSync();

            // Execute completion callback if provided
            if (onComplete) {
              await onComplete();
            }
            break;
        }
      });

      // Handle worker errors
      this.worker.on('error', (error) => {
        console.error('Worker error:', error);
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
          message: error.message,
        });
        this.stopSync();
      });

      // Handle worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker stopped with exit code ${code}`);
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
            message: `Worker process exited with code ${code}`,
          });
        }
        this.worker = null;
      });
    } catch (error) {
      console.error('Error starting codebase sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopSync();
    }
  }

  private async saveProcessedFile(file: ProcessedFile, repoName: string): Promise<void> {
    try {
      // Save the file content to the output directory
      const outputFilePath = path.join(
        this.context.globalStorageUri.fsPath,
        repoName,
        'codebase',
        'files',
        `${path.basename(file.filename)}.json`
      );
      
      await fs.promises.writeFile(
        outputFilePath,
        JSON.stringify({
          filename: file.filename,
          text: file.text,
          filePath: file.filePath
        })
      );
    } catch (error) {
      console.error('Error saving processed file:', error);
    }
  }

  public stopSync(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  public getSyncProgress(): SyncProgress | null {
    return this.syncProgress;
  }

  public async resetSyncProgress(): Promise<void> {
    this.syncProgress = null;
    await this.context.globalState.update(
      STORAGE_KEYS.CODEBASE_SYNC_PROGRESS,
      undefined
    );
  }

  public async createEmbeddings(resume: boolean = false, repoName: string): Promise<void> {
    try {
      // Create codebase embeddings directory
      const embeddingDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        repoName,
        'codebase',
        'embeddings'
      );
      await this.ensureDirectoryExists(embeddingDirPath);

      // Start the embedding worker
      const workerPath = path.join(__dirname, 'workers','codebase', 'codebaseEmbeddingWorker.js');
      const worker = new Worker(workerPath, {
        workerData: {
          codebaseDirPath: path.join(
            this.context.globalStorageUri.fsPath,
            repoName,
            'codebase',
            'files'
          ),
          embeddingDirPath,
          config: {
            dimensions: MODEL.DEFAULT_DIMENSIONS,
          },
          resume: resume
        },
      });

      // Handle worker messages
      worker.on('message', (message) => {
        if (message.type === WORKER_STATUS.COMPLETED) {
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE,
            source: 'codebase',
            message: 'Codebase embedding complete',
          });
        } else if (message.type === WORKER_STATUS.ERROR) {
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
            message: message.message,
          });
        } else if (message.type === WORKER_STATUS.PROCESSING) {
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.SYNC_CODEBASE_IN_PROGRESS,
            message: message.message,
            progress: message.progress,
          });
        }
      });

      worker.on('error', (error) => {
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
          message: error.message,
        });
      });
    } catch (error) {
      console.error('Error in Codebase embedding:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public async searchCodebase(query: string): Promise<any[]> {
    try {
      // Find all embedding directories in globalStorageUri
      const embeddingDirPaths = await this.findAllEmbeddingDirectories();
      
      // Create a new worker for search
      const workerPath = path.join(__dirname, 'workers','codebase', 'codebaseSearchWorker.js');
      const searchWorker = new Worker(workerPath, {
        workerData: {
          query,
          embeddingDirPath: embeddingDirPaths,
        },
      });

      return new Promise((resolve, reject) => {
        searchWorker.on('message', (results) => {
          resolve(results);
          searchWorker.terminate();
        });

        searchWorker.on('error', (error) => {
          reject(error);
          searchWorker.terminate();
        });
      });
    } catch (error) {
      console.error('Error in codebase search:', error);
      throw error;
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

  private async findAllEmbeddingDirectories(): Promise<string[]> {
    try {
      const baseDir = this.context.globalStorageUri.fsPath;
      const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
      
      const embeddingDirPaths: string[] = [];
      
      // Check each directory in the base directory
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const potentialEmbeddingDir = path.join(baseDir, entry.name, 'codebase', 'embeddings');
          
          try {
            // Check if the potential embedding directory exists
            await fs.promises.access(potentialEmbeddingDir);
            embeddingDirPaths.push(potentialEmbeddingDir);
          } catch (error) {
            // Directory doesn't exist, skip it
            continue;
          }
        }
      }
      
      // If no embedding directories found, return the default path
      if (embeddingDirPaths.length === 0) {
        const defaultPath = path.join(baseDir, 'codebase', 'embeddings');
        await this.ensureDirectoryExists(defaultPath);
        embeddingDirPaths.push(defaultPath);
      }
      
      return embeddingDirPaths;
    } catch (error) {
      console.error('Error finding embedding directories:', error);
      // Return default path in case of error
      return [path.join(this.context.globalStorageUri.fsPath, 'codebase', 'embeddings')];
    }
  }
}