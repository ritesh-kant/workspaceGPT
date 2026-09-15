import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { promisify } from 'util';
import { MESSAGE_TYPES, WORKER_STATUS, STORAGE_KEYS } from '../../../constants';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';
import { normalizeSiteUrl } from './jiraAuthService';

/**
 * Sync orchestration — spawns jiraWorker.ts, tracks resumable progress,
 * writes synced issues to disk as markdown. Mirrors adoService.ts; see
 * JIRA-INTEGRATION-DESIGN.md §5 P5 for why this is a parallel file rather
 * than a shared abstraction with it.
 */

interface ProcessedJiraItem {
  filename: string;
  text: string;
  url?: string;
}

export interface JiraSyncConfig {
  siteUrl: string;
  projectKey: string;
  authHeader: string;
  lookbackMonths: number;
}

interface SyncProgress {
  processedItems: number;
  totalItems: number;
  lastProcessedId?: string;
  isComplete: boolean;
  lastSyncTime: string;
}

// Same interval as ADO's — comfortably under an API token's effective
// lifetime (Jira API tokens don't expire on a fixed clock the way a Bearer
// access token does, but refreshing periodically costs nothing and keeps the
// two sync paths symmetric).
const AUTH_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

export class JiraService {
  private worker: Worker | null = null;
  private webviewView?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private syncProgress: SyncProgress | null = null;
  private authRefreshInterval: NodeJS.Timeout | null = null;

  constructor(webviewView: vscode.WebviewView | undefined, context: vscode.ExtensionContext) {
    this.webviewView = webviewView;
    this.context = context;
    this.loadSyncProgress();
  }

  private loadSyncProgress(): void {
    try {
      const progress = this.context.globalState.get<SyncProgress>(STORAGE_KEYS.JIRA_SYNC_PROGRESS);
      this.syncProgress = progress || null;
    } catch (error) {
      console.error('Error loading Jira sync progress:', error);
      this.syncProgress = null;
    }
  }

  private async saveSyncProgress(progress: SyncProgress): Promise<void> {
    try {
      await this.context.globalState.update(STORAGE_KEYS.JIRA_SYNC_PROGRESS, progress);
      this.syncProgress = progress;
    } catch (error) {
      console.error('Error saving Jira sync progress:', error);
    }
  }

  public async startSync(
    config: JiraSyncConfig,
    onComplete?: () => Promise<void>,
    resume: boolean = false,
    onError?: (error: Error) => void,
    getAuthHeader?: () => Promise<string>
  ): Promise<void> {
    try {
      this.stopSync();

      let isIncremental = false;
      let lastSyncTimeStr = '';

      if (resume && this.syncProgress) {
        console.log(`Resuming Jira sync from ${this.syncProgress.processedItems}/${this.syncProgress.totalItems} items`);
      } else {
        if (this.syncProgress && this.syncProgress.lastSyncTime) {
          isIncremental = true;
          lastSyncTimeStr = this.syncProgress.lastSyncTime;
          console.log(`Starting incremental Jira sync from ${lastSyncTimeStr}`);
        } else {
          const mdDirPath = path.join(this.context.globalStorageUri.fsPath, 'jira', 'mds');
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

      const workerPath = path.join(__dirname, 'workers', 'jira', 'jiraWorker.js');

      this.worker = new Worker(workerPath, {
        workerData: {
          siteUrl: normalizeSiteUrl(config.siteUrl),
          projectKey: config.projectKey,
          authHeader: config.authHeader,
          resume,
          lastProcessedId: this.syncProgress?.lastProcessedId,
          processedItems: this.syncProgress?.processedItems || 0,
          isIncremental,
          lastSyncTime: lastSyncTimeStr,
          lookbackMonths: config.lookbackMonths,
        },
      });

      this.worker.on('message', async (message) => {
        switch (message.type) {
          case WORKER_STATUS.PROCESSING:
            this.webviewView?.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_JIRA_IN_PROGRESS,
              source: 'jira',
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
            console.error(`Jira worker error: ${message.message}`);
            this.webviewView?.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_JIRA_ERROR,
              message: message.message,
            });
            this.stopSync();
            if (onError) {
              onError(new Error(message.message));
            }
            break;

          case WORKER_STATUS.COMPLETED: {
            console.log(`Jira sync complete. Processed ${message.itemsCount} items.`);
            const lastSyncTime = new Date().toISOString();
            this.webviewView?.webview.postMessage({
              type: MESSAGE_TYPES.SYNC_JIRA_COMPLETE,
              source: 'jira',
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
        }
      });

      if (getAuthHeader) {
        this.authRefreshInterval = setInterval(async () => {
          try {
            const freshHeader = await getAuthHeader();
            this.worker?.postMessage({ type: 'refresh-auth', authHeader: freshHeader });
          } catch (error) {
            console.error('Failed to refresh Jira auth token for sync worker:', error);
          }
        }, AUTH_REFRESH_INTERVAL_MS);
      }

      this.worker.on('error', (error) => {
        console.error('Jira worker error:', error);
        this.webviewView?.webview.postMessage({
          type: MESSAGE_TYPES.SYNC_JIRA_ERROR,
          message: error.message,
        });
        this.stopSync();
        if (onError) {
          onError(error);
        }
      });
    } catch (error) {
      console.error('Error starting Jira worker:', error);
      this.webviewView?.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_JIRA_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      this.stopSync();
    }
  }

  public stopSync(): void {
    if (this.authRefreshInterval) {
      clearInterval(this.authRefreshInterval);
      this.authRefreshInterval = null;
    }
    if (this.worker) {
      console.log('Stopping Jira sync process...');
      this.worker.terminate();
      this.worker = null;
      console.log('Jira sync process stopped');
    }
  }

  public getSyncProgress(): SyncProgress | null {
    return this.syncProgress;
  }

  public async resetSyncProgress(): Promise<void> {
    this.syncProgress = null;
    await this.context.globalState.update(STORAGE_KEYS.JIRA_SYNC_PROGRESS, undefined);
  }

  private async saveProcessedItemAsMd(item: ProcessedJiraItem): Promise<void> {
    try {
      const mdDirPath = path.join(this.context.globalStorageUri.fsPath, 'jira', 'mds');
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
    } catch (error) {
      console.error('Error saving Jira MD file:', error);
      throw error;
    }
  }
}
