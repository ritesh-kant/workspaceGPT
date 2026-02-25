import * as vscode from 'vscode';
import { ConfluenceService, ConfluenceConfig } from './confluenceService';
import { ConfluenceAuthService } from './confluenceAuthService';
import { EmbeddingService } from './confluenceEmbeddingService';
import { EmbeddingConfig } from '../types/types';
import { MODEL, STORAGE_KEYS } from '../../constants';

// 4 hours in milliseconds
const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Check every 15 minutes
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export class ConfluenceSyncScheduler {
  private intervalId?: NodeJS.Timeout;
  private confluenceAuthService: ConfluenceAuthService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.confluenceAuthService = new ConfluenceAuthService(context);
  }

  public start() {
    this.intervalId = setInterval(() => this.checkAndSync(), CHECK_INTERVAL_MS);
    // Optionally check immediately on start
    this.checkAndSync();
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private async checkAndSync() {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      if (!config?.state?.config?.confluence?.isAuthenticated || !config?.state?.config?.confluence?.spaceKey) {
        return; // Not fully configured yet
      }

      // Check if another sync is currently in progress
      if (config.state.config.confluence.isSyncing || config.state.config.confluence.isIndexing) {
        return; 
      }

      const lastSyncTimeStr = config.state.config.confluence.lastSyncTime;
      if (!lastSyncTimeStr) {
        return; // Never synced before, don't auto-sync
      }

      const lastSyncTime = new Date(lastSyncTimeStr).getTime();
      const now = Date.now();

      if (now - lastSyncTime >= SYNC_INTERVAL_MS) {
        console.log('🔄 Triggering automated background sync...');
        await this.runSync();
      }
    } catch (err) {
      console.error('Background sync check failed:', err);
    }
  }

  private async runSync() {
    try {
      const accessToken = await this.confluenceAuthService.getValidAccessToken();
      const site = this.confluenceAuthService.getStoredSite();
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const spaceKey = config?.state?.config?.confluence?.spaceKey;

      if (!site || !accessToken || !spaceKey) {
          throw new Error('Confluence config incomplete');
      }

      // Update state to syncing before kicking off
      if (config?.state?.config?.confluence) {
          config.state.config.confluence.isSyncing = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      const confluenceConfig: ConfluenceConfig = {
          cloudId: site.id,
          accessToken,
          spaceKey,
      };

      const confluenceService = new ConfluenceService(undefined, this.context);
      const embeddingService = new EmbeddingService(undefined, this.context);

      await confluenceService.startSync(confluenceConfig, async () => {
        // Complete callback: update last sync time and start embeddings
        const syncTime = new Date().toISOString();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.confluence) {
          settings.state.config.confluence.lastSyncTime = syncTime;
          settings.state.config.confluence.isSyncing = false;
          settings.state.config.confluence.isIndexing = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }

        await embeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);
      });

    } catch (e) {
      console.error('Automated background sync failed:', e);
      // Reset syncing state on error
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      if (config?.state?.config?.confluence) {
          config.state.config.confluence.isSyncing = false;
          config.state.config.confluence.isIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    }
  }
}
