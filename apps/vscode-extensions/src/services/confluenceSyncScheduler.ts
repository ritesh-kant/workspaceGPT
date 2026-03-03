import * as vscode from 'vscode';
import { ConfluenceService, ConfluenceConfig } from './confluenceService';
import { ConfluenceAuthService } from './confluenceAuthService';
import { EmbeddingService } from './confluenceEmbeddingService';
import { EmbeddingConfig } from '../types/types';
import { CHECK_INTERVAL_MS, MODEL, STORAGE_KEYS, SYNC_INTERVAL_MS } from '../../constants';

// If isSyncing/isIndexing has been stuck true for longer than this, auto-reset it.
// This handles edge cases like VS Code crashing mid-sync.
const STALE_FLAG_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export class ConfluenceSyncScheduler {
  private intervalId?: NodeJS.Timeout;
  private confluenceAuthService: ConfluenceAuthService;
  private syncStartedAt?: number;

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
        // Guard against stale flags: if a sync was started by this scheduler
        // instance and has been running for over an hour, the worker likely
        // crashed without resetting state. Auto-recover.
        if (this.syncStartedAt && (Date.now() - this.syncStartedAt > STALE_FLAG_TIMEOUT_MS)) {
          console.warn('⚠️ Auto-sync: isSyncing/isIndexing stuck for over 1 hour — resetting stale flags');
          config.state.config.confluence.isSyncing = false;
          config.state.config.confluence.isIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
          this.syncStartedAt = undefined;
        } else {
          console.log('⏳ Auto-sync: skipped — sync or indexing already in progress');
          return;
        }
      }

      const lastSyncTimeStr = config.state.config.confluence.lastSyncTime;
      if (!lastSyncTimeStr) {
        return; // Never synced before, don't auto-sync
      }

      const lastSyncTime = new Date(lastSyncTimeStr).getTime();
      const now = Date.now();
      const elapsed = now - lastSyncTime;

      if (elapsed >= SYNC_INTERVAL_MS) {
        console.log(`🔄 Triggering automated background sync (last sync ${Math.round(elapsed / 60000)} min ago)...`);
        await this.runSync();
      }
    } catch (err) {
      console.error('Background sync check failed:', err);
    }
  }

  private async resetSyncFlags() {
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (config?.state?.config?.confluence) {
      config.state.config.confluence.isSyncing = false;
      config.state.config.confluence.isIndexing = false;
      await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
    }
    this.syncStartedAt = undefined;
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
      this.syncStartedAt = Date.now();

      const confluenceConfig: ConfluenceConfig = {
          cloudId: site.id,
          accessToken,
          spaceKey,
          siteUrl: site.url,
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

        console.log('🔄 Auto-sync: page sync complete, starting embedding indexing...');

        await embeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);

        // Reset isIndexing after embeddings complete so future scheduled syncs aren't blocked
        const updatedSettings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (updatedSettings?.state?.config?.confluence) {
          updatedSettings.state.config.confluence.isIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, updatedSettings);
        }
        this.syncStartedAt = undefined;
        console.log('✅ Auto-sync: complete');
      }, false, (error: Error) => {
        // Error callback: reset flags so future scheduled syncs aren't blocked
        console.error('❌ Auto-sync: worker error:', error.message);
        this.resetSyncFlags();
      });

    } catch (e) {
      console.error('Automated background sync failed:', e);
      await this.resetSyncFlags();
    }
  }
}
