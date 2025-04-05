import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { promisify } from 'util';
import { MESSAGE_TYPES, WORKER_STATUS } from '../../constants';

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

export class ConfluenceService {
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

  public async startSync(
    config: ConfluenceConfig,
    onComplete?: () => Promise<void>
  ): Promise<void> {
    try {
      // Stop any existing worker
      this.stopSync();

      // Create a new worker
      const workerPath = path.join(__dirname, 'workers', 'confluenceWorker.js');
      this.worker = new Worker(workerPath, {
        workerData: {
          spaceKey: config.spaceKey,
          confluenceBaseUrl: config.baseUrl,
          apiToken: config.apiToken,
          userEmail: config.userEmail,
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
            type: MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR,
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

      // Write the content to the file
      const writeFile = promisify(fs.writeFile);
      await writeFile(mdFilePath, page.text, 'utf8');

      console.log(`Saved MD file: ${page.filename}.md`);
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
