import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';

interface ProcessedPage {
  title: string;
  url: string;
  content: string;
}

interface ConfluenceConfig {
  baseUrl: string;
  spaceKey: string;
  userEmail: string;
  apiToken: string;
}

export class ConfluenceWorkerManager {
  private worker: Worker | null = null;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;

  constructor(webviewView: vscode.WebviewView, context: vscode.ExtensionContext) {
    this.webviewView = webviewView;
    this.context = context;
  }

  public async startSync(config: ConfluenceConfig): Promise<void> {
    try {
      // Stop any existing worker
      this.stopSync();

      // Create a new worker
      const workerPath = path.join(__dirname, '..', 'workers', 'confluenceWorker.js');
      this.worker = new Worker(workerPath, {
        workerData: {
          spaceKey: config.spaceKey,
          confluenceBaseUrl: config.baseUrl,
          apiToken: config.apiToken,
          userEmail: config.userEmail
        }
      });

      // Handle messages from the worker
      this.worker.on('message', async (message) => {
        switch (message.type) {
          case 'totalPages':
            console.log(`Total pages found: ${message.count}`);
            break;

          case 'pagesFetched':
            console.log(`Pages fetched: ${message.count}`);
            break;

          case 'progress':
            // Update progress in the webview
            this.webviewView.webview.postMessage({
              type: 'syncProgress',
              source: 'confluence',
              progress: message.progress,
              current: message.current,
              total: message.total
            });
            break;

          case 'error':
            console.error(`Worker error: ${message.message}`);
            this.webviewView.webview.postMessage({
              type: 'syncError',
              message: message.message
            });
            break;

          case 'complete':
            console.log(`Sync complete. Processed ${message.pages.length} pages.`);
            
            // Save the processed pages to global state
            await this.saveToGlobalState(message.pages);
            
            // Notify the webview that sync is complete
            this.webviewView.webview.postMessage({
              type: 'syncComplete',
              source: 'confluence',
              pagesCount: message.pages.length
            });
            
            // Clean up the worker
            this.stopSync();
            break;
        }
      });

      // Handle worker errors
      this.worker.on('error', (error) => {
        console.error('Worker error:', error);
        this.webviewView.webview.postMessage({
          type: 'syncError',
          message: error.message
        });
        this.stopSync();
      });

      // Handle worker exit
      this.worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Worker stopped with exit code ${code}`);
          this.webviewView.webview.postMessage({
            type: 'syncError',
            message: `Worker process exited with code ${code}`
          });
        }
        this.worker = null;
      });

    } catch (error) {
      console.error('Error starting worker:', error);
      this.webviewView.webview.postMessage({
        type: 'syncError',
        message: error instanceof Error ? error.message : String(error)
      });
      this.stopSync();
    }
  }

  public stopSync(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private async saveToGlobalState(pages: ProcessedPage[]): Promise<void> {
    try {
      // Get existing confluence data or initialize empty object
      const existingData = this.context.globalState.get('workspaceGPT-confluence-data') || {};
      
      // Update with new pages data
      const updatedData = {
        ...existingData,
        pages: pages,
        lastSyncTime: new Date().toISOString()
      };
      
      // Save to global state
      await this.context.globalState.update('workspaceGPT-confluence-data', updatedData);
      console.log('Saved confluence data to global state');
    } catch (error) {
      console.error('Error saving to global state:', error);
      throw error;
    }
  }
}