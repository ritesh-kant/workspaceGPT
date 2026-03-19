import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { promisify } from 'util';
import { MESSAGE_TYPES, WORKER_STATUS, STORAGE_KEYS } from '../../../constants';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';

interface ProcessedAdoItem {
  filename: string;
  text: string;
  url?: string;
}

export interface AdoConfig {
  orgName: string;
  projectName: string;
  accessToken: string;
  lookbackMonths: number;
}

interface SyncProgress {
  processedItems: number;
  totalItems: number;
  lastProcessedId?: string;
  isComplete: boolean;
  lastSyncTime: string;
}

export class AdoService {
  private worker: Worker | null = null;
  private webviewView?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private syncProgress: SyncProgress | null = null;

  constructor(
    webviewView: vscode.WebviewView | undefined,
    context: vscode.ExtensionContext
  ) {
    this.webviewView = webviewView;
    this.context = context;
    this.loadSyncProgress();
  }

  private async loadSyncProgress(): Promise<void> {
    try {
      const progress = await this.context.globalState.get<SyncProgress>(
        STORAGE_KEYS.ADO_SYNC_PROGRESS
      );
      this.syncProgress = progress || null;
    } catch (error) {
      console.error('Error loading ADO sync progress:', error);
      this.syncProgress = null;
    }
  }

  private async saveSyncProgress(progress: SyncProgress): Promise<void> {
    try {
      await this.context.globalState.update(
        STORAGE_KEYS.ADO_SYNC_PROGRESS,
        progress
      );
      this.syncProgress = progress;
    } catch (error) {
      console.error('Error saving ADO sync progress:', error);
    }
  }

  async getTotalItems(config: AdoConfig): Promise<number> {
    try {
      const authHeader = `Basic ${Buffer.from(`:${config.accessToken}`).toString('base64')}`;
      const url = `https://dev.azure.com/${encodeURIComponent(config.orgName)}/${encodeURIComponent(config.projectName)}/_apis/wit/wiql?api-version=7.1&$top=20000`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${config.projectName}' AND [System.ChangedDate] >= @today - ${config.lookbackMonths * 30} ORDER BY [System.ChangedDate] DESC`,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to query ADO (${response.status}): ${text.substring(0, 200)}`);
      }

      const data: any = await response.json();
      return (data.workItems || []).length;
    } catch (error) {
      console.error('Error fetching ADO total items count:', error);
      throw error;
    }
  }

  public async startSync(
    config: AdoConfig,
    onComplete?: () => Promise<void>,
    resume: boolean = false,
    onError?: (error: Error) => void,
  ): Promise<void> {
    try {
      this.stopSync();

      let isIncremental = false;
      let lastSyncTimeStr = '';

      if (resume && this.syncProgress) {
        console.log(`Resuming ADO sync from ${this.syncProgress.processedItems}/${this.syncProgress.totalItems} items`);
      } else {
        if (this.syncProgress && this.syncProgress.lastSyncTime) {
          isIncremental = true;
          lastSyncTimeStr = this.syncProgress.lastSyncTime;
          console.log(`Starting incremental ADO sync from ${lastSyncTimeStr}`);
        } else {
          const mdDirPath = path.join(
            this.context.globalStorageUri.fsPath,
            'ado',
            'mds'
          );
          await deleteDirectory(mdDirPath);
        }

        this.syncProgress = {
          processedItems: 0,
          totalItems: 0,
          isComplete: false,
          lastSyncTime: lastSyncTimeStr,
        };
        await this.saveSyncProgress(this.syncProgress);
      }

      const workerPath = path.join(
        __dirname,
        'workers',
        'ado',
        'adoWorker.js'
      );
      
      this.worker = new Worker(workerPath, {
        workerData: {
          orgName: config.orgName,
          projectName: config.projectName,
          accessToken: config.accessToken,
          resume: resume,
          lastProcessedId: this.syncProgress?.lastProcessedId,
          processedItems: this.syncProgress?.processedItems || 0,
          isIncremental: isIncremental,
          lastSyncTime: lastSyncTimeStr,
          lookbackMonths: config.lookbackMonths,
        },
      });

      this.worker.on('message', async (message) => {
        switch (message.type) {
          case WORKER_STATUS.PROCESSING:
            this.webviewView?.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_ADO_IN_PROGRESS,
              source: 'ado',
              progress: message.progress,
              current: message.current,
              total: message.total,
            });

            this.syncProgress = {
              processedItems: message.current,
              totalItems: message.total,
              lastProcessedId: message.lastProcessedId,
              isComplete: false,
              lastSyncTime: this.syncProgress?.lastSyncTime || '',
            };
            await this.saveSyncProgress(this.syncProgress);
            break;

          case WORKER_STATUS.PROCESSED:
            await this.saveProcessedItemAsMd(message.item);
            break;

          case WORKER_STATUS.ERROR:
            console.error(`ADO Worker error: ${message.message}`);
            this.webviewView?.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_ADO_ERROR,
              message: message.message,
            });
            if (onError) {
              onError(new Error(message.message));
            }
            break;

          case WORKER_STATUS.COMPLETED:
            console.log(`ADO Sync complete. Processed ${message.itemsCount} items.`);
            const lastSyncTime = new Date().toISOString();
            this.webviewView?.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_ADO_COMPLETE,
              source: 'ado',
              itemsCount: message.itemsCount,
              lastSyncTime,
            });

            this.syncProgress = {
              processedItems: message.itemsCount,
              totalItems: message.itemsCount,
              isComplete: true,
              lastSyncTime,
            };
            await this.saveSyncProgress(this.syncProgress);

            this.stopSync();

            if (onComplete) {
              await onComplete();
            }
            break;
        }
      });

      this.worker.on('error', (error) => {
        console.error('ADO Worker error:', error);
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.SYNC_ADO_ERROR,
          message: error.message,
        });
        this.stopSync();
        if (onError) {
          onError(error);
        }
      });

    } catch (error) {
      console.error('Error starting ADO worker:', error);
      this.webviewView?.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopSync();
    }
  }

  public stopSync(): void {
    if (this.worker) {
      console.log('Stopping ADO sync process...');
      this.worker.terminate();
      this.worker = null;
      console.log('ADO sync process stopped');
    }
  }

  public getSyncProgress(): SyncProgress | null {
    return this.syncProgress;
  }

  public async resetSyncProgress(): Promise<void> {
    this.syncProgress = null;
    await this.context.globalState.update(
      STORAGE_KEYS.ADO_SYNC_PROGRESS,
      undefined
    );
  }

  private async saveProcessedItemAsMd(item: ProcessedAdoItem): Promise<void> {
    try {
      const mdDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'ado',
        'mds'
      );
      await ensureDirectoryExists(mdDirPath);

      const mdFilePath = path.join(mdDirPath, `${item.filename}.md`);

      let contentWithMetadata = item.text;
      if (item.url) {
        contentWithMetadata = `---
url: ${item.url}
fileName: ${item.filename}
---
${item.text}`;
      }

      const writeFile = promisify(fs.writeFile);
      await writeFile(mdFilePath, contentWithMetadata, 'utf8');

      console.log(`Saved ADO MD file: ${item.filename}.md${item.url ? ' with metadata' : ''}`);
    } catch (error) {
      console.error('Error saving ADO MD file:', error);
      throw error;
    }
  }
}
