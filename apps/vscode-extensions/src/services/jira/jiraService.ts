import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { promisify } from 'util';
import { MESSAGE_TYPES, WORKER_STATUS, STORAGE_KEYS } from '../../../constants';
import { postToWebview } from 'src/utils/webviewBroadcast';
import { deleteDirectory } from 'src/utils/deleteDirectory';
import { ensureDirectoryExists } from 'src/utils/ensureDirectoryExists';

/**
 * Sync orchestration — spawns jiraWorker.ts, tracks resumable progress,
 * writes synced issues to disk as markdown. Mirrors adoService.ts; see
 * docs/design/jira.md §5 P5 for why this is a parallel file rather
 * than a shared abstraction with it.
 */

interface ProcessedJiraItem {
  filename: string;
  text: string;
  url?: string;
}

export interface JiraSyncConfig {
  /** The site's real domain, e.g. `https://yourcompany.atlassian.net` — used only for the synced markdown's `/browse/{key}` urls. */
  siteUrl: string;
  /** `https://api.atlassian.com/ex/jira/{cloudId}` — every REST call the worker makes goes here. */
  apiBase: string;
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

// Same interval as ADO's. Now load-bearing rather than cosmetic: the OAuth
// access token this header carries expires on a real clock (Atlassian's
// tokens live about an hour), and getValidAuthHeader() only renews it when
// asked — 20 minutes keeps a multi-hour sync comfortably ahead of expiry
// without every call needing its own refresh check.
const AUTH_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

export class JiraService {
  // One sync worker per source per host. The sync scheduler and the settings
  // panel each build their own instance, and Stop has to reach whichever run
  // is live; two runs would also write the same files.
  private static activeWorker: Worker | null = null;
  private get worker(): Worker | null {
    return JiraService.activeWorker;
  }
  private set worker(value: Worker | null) {
    JiraService.activeWorker = value;
  }
  private webviewView?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private syncProgress: SyncProgress | null = null;
  private authRefreshInterval: NodeJS.Timeout | null = null;

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
      // Re-read: another instance (scheduler or panel) may have advanced it.
      this.loadSyncProgress();

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
          siteUrl: config.siteUrl,
          apiBase: config.apiBase,
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
            this.post({
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
            this.post({
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
            this.post({
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
        this.post({
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
      this.post({
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
