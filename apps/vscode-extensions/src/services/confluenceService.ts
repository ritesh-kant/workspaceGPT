import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { promisify } from 'util';
import { MESSAGE_TYPES, WORKER_STATUS, STORAGE_KEYS } from '../../constants';
import { ConfluencePageFetcher } from '@workspace-gpt/confluence-utils';

interface ProcessedPage {
  filename: string;
  text: string;
  pageUrl?: string;
}

interface ConfluenceConfig {
  baseUrl: string;
  spaceKey: string;
  userEmail: string;
  apiToken: string;
}

interface SyncProgress {
  processedPages: number;
  totalPages: number;
  lastProcessedPageId?: string;
  isComplete: boolean;
}

export class ConfluenceService {
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
        STORAGE_KEYS.CONFLUENCE_SYNC_PROGRESS
      );
      this.syncProgress = progress || null;
    } catch (error) {
      console.error('Error loading sync progress:', error);
      this.syncProgress = null;
    }
  }

  private async saveSyncProgress(progress: SyncProgress): Promise<void> {
    try {
      await this.context.globalState.update(
        STORAGE_KEYS.CONFLUENCE_SYNC_PROGRESS,
        progress
      );
      this.syncProgress = progress;
    } catch (error) {
      console.error('Error saving sync progress:', error);
    }
  }

  async getTotalPages(config: ConfluenceConfig) {
    try {
      // Create the page fetcher
      const extractor = new ConfluencePageFetcher(
        config.spaceKey,
        config.baseUrl,
        config.apiToken,
        config.userEmail,
        config.apiToken
      );

      // Get total pages count
      const totalSize = await extractor.getTotalPages();
      return totalSize; // Return the total pages coun
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('❌ Error getting total pages:', errorMessage);
      throw error;
    }
  }

  public async startSync(
    config: ConfluenceConfig,
    onComplete?: () => Promise<void>,
    resume: boolean = false
  ): Promise<void> {
    try {
      // Stop any existing worker
      this.stopSync();

      // Load the current progress if resuming
      if (resume && this.syncProgress) {
        console.log(
          `Resuming sync from ${this.syncProgress.processedPages}/${this.syncProgress.totalPages} pages`
        );
      } else {
        // Reset progress if not resuming
        this.syncProgress = {
          processedPages: 0,
          totalPages: 0,
          isComplete: false,
        };
        await this.saveSyncProgress(this.syncProgress);
      }

      // Create a new worker
      const workerPath = path.join(
        __dirname,
        'workers',
        'confluence',
        'confluenceWorker.js'
      );
      this.worker = new Worker(workerPath, {
        workerData: {
          spaceKey: config.spaceKey,
          confluenceBaseUrl: config.baseUrl,
          apiToken: config.apiToken,
          userEmail: config.userEmail,
          resume: resume,
          lastProcessedPageId: this.syncProgress?.lastProcessedPageId,
          processedPages: this.syncProgress?.processedPages || 0,
        },
      });

      // Handle messages from the worker
      this.worker.on('message', async (message) => {
        switch (message.type) {
          case WORKER_STATUS.PROCESSING:
            // Update progress in the webview
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_CONFLUENCE_IN_PROGRESS,
              source: 'confluence',
              progress: message.progress,
              current: message.current,
              total: message.total,
            });

            // Update and save progress
            this.syncProgress = {
              processedPages: message.current,
              totalPages: message.total,
              lastProcessedPageId: message.lastProcessedPageId,
              isComplete: false,
            };
            await this.saveSyncProgress(this.syncProgress);
            break;

          case WORKER_STATUS.PROCESSED:
            // Save individual processed page as MD file
            await this.saveProcessedPageAsMd(message.page);
            break;

          case WORKER_STATUS.ERROR:
            console.error(`Worker error: ${message.message}`);
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
              message: message.message,
            });
            break;

          case WORKER_STATUS.COMPLETED:
            console.log(
              `Sync complete. Processed ${message.pages.length} pages.`
            );
            // Notify the webview that sync is complete
            this.webviewView.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_CONFLUENCE_COMPLETE,
              source: 'confluence',
              pagesCount: message.pages.length,
            });

            // Update progress as complete
            this.syncProgress = {
              processedPages: message.pages.length,
              totalPages: message.pages.length,
              isComplete: true,
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
          type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
          message: error.message,
        });
        this.stopSync();
      });

      // Handle worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker stopped with exit code ${code}`);
          // Notify the webview that sync is being stopped
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.SYNC_CONFLUENCE_STOP,
            source: 'confluence',
            progress: 0,
            message: 'Stopping sync process...',
          });
        }
        this.worker = null;
      });
    } catch (error) {
      console.error('Error starting worker:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopSync();
    }
  }

  public stopSync(): void {
    if (this.worker) {
      console.log('Stopping Confluence sync process...');
      // Terminate the worker
      this.worker.terminate();
      this.worker = null;

      console.log('Confluence sync process stopped');
    }
  }

  public getSyncProgress(): SyncProgress | null {
    return this.syncProgress;
  }

  public async resetSyncProgress(): Promise<void> {
    this.syncProgress = null;
    await this.context.globalState.update(
      STORAGE_KEYS.CONFLUENCE_SYNC_PROGRESS,
      undefined
    );
  }

  private async saveProcessedPageAsMd(page: ProcessedPage): Promise<void> {
    try {
      // Create the directory path for storing MD files
      const mdDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'confluence',
        'mds'
      );

      // Ensure the directory exists
      await this.ensureDirectoryExists(mdDirPath);

      // Create the file path for the MD file
      const mdFilePath = path.join(mdDirPath, `${page.filename}.md`);

      // Add frontmatter with metadata if pageUrl exists
      let contentWithMetadata = page.text;
      if (page.pageUrl) {
        contentWithMetadata = `---
        url: ${page.pageUrl}
        ---
        ${page.text}`;
      }

      // Write the content to the file
      const writeFile = promisify(fs.writeFile);
      await writeFile(mdFilePath, contentWithMetadata, 'utf8');

      console.log(
        `Saved MD file: ${page.filename}.md${page.pageUrl ? ' with metadata' : ''}`
      );
    } catch (error) {
      console.error('Error saving MD file:', error);
      throw error;
    }
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      // Check if directory exists
      await promisify(fs.access)(dirPath).catch(async () => {
        // Create directory recursively if it doesn't exist
        await promisify(fs.mkdir)(dirPath, { recursive: true });
      });
    } catch (error) {
      console.error('Error creating directory:', error);
      throw error;
    }
  }
}
