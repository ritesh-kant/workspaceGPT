import * as vscode from 'vscode';
import { AdoService, AdoConfig } from './adoService';
import { AdoAuthService } from './adoAuthService';
import { AdoEmbeddingService } from './adoEmbeddingService';
import { EmbeddingConfig } from '../../types/types';
import { MODEL, STORAGE_KEYS, SYNC_INTERVAL_MS } from '../../../constants';

// If isSyncing/isIndexing has been stuck true for longer than this, auto-reset it.
// This handles edge cases like VS Code crashing mid-sync.
const STALE_FLAG_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export class AdoSyncScheduler {
  private intervalId?: NodeJS.Timeout;
  private syncStartedAt?: number;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public start() {
    this.intervalId = setInterval(() => this.checkAndSync(), SYNC_INTERVAL_MS);
    // Determine if we should sync immediately on start
    this.checkAndSync(true);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private async checkAndSync(force: boolean = false) {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      if (!config?.state?.config?.ado?.isAuthenticated || !config?.state?.config?.ado?.orgName || !config?.state?.config?.ado?.projectName) {
        return; // Not fully configured yet
      }

      // Check if another sync is currently in progress
      if (config.state.config.ado.isSyncing || config.state.config.ado.isIndexing) {
        // Guard against stale flags
        if (this.syncStartedAt && (Date.now() - this.syncStartedAt > STALE_FLAG_TIMEOUT_MS)) {
          console.warn('⚠️ Auto-sync ADO: isSyncing/isIndexing stuck for over 1 hour — resetting stale flags');
          config.state.config.ado.isSyncing = false;
          config.state.config.ado.isIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
          this.syncStartedAt = undefined;
        } else {
          console.log('⏳ Auto-sync ADO: skipped — sync or indexing already in progress');
          return;
        }
      }

      const lastSyncTimeStr = config.state.config.ado.lastSyncTime;
      if (!lastSyncTimeStr) {
        return; // Never synced before, don't auto-sync
      }

      const lastSyncTime = new Date(lastSyncTimeStr).getTime();
      const now = Date.now();
      const elapsed = now - lastSyncTime;

      if (force || elapsed >= SYNC_INTERVAL_MS) {
        console.log(`🔄 Triggering automated ADO background sync (force: ${force}, last sync ${Math.round(elapsed / 60000)} min ago)...`);
        await this.runSync();
      }
    } catch (err) {
      console.error('ADO Background sync check failed:', err);
    }
  }

  private async resetSyncFlags() {
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (config?.state?.config?.ado) {
      config.state.config.ado.isSyncing = false;
      config.state.config.ado.isIndexing = false;
      await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
    }
    this.syncStartedAt = undefined;
  }

  private async runSync() {
    try {
      const authService = new AdoAuthService(this.context);
      const accessToken = await authService.getValidAccessToken();
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const orgName = config?.state?.config?.ado?.orgName;
      const projectName = config?.state?.config?.ado?.projectName;
      const lookbackMonths = config?.state?.config?.ado?.lookbackMonths || 24;

      if (!accessToken || !orgName || !projectName) {
          throw new Error('ADO config incomplete');
      }

      // Update state to syncing before kicking off
      if (config?.state?.config?.ado) {
          config.state.config.ado.isSyncing = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
      this.syncStartedAt = Date.now();

      const adoConfig: AdoConfig = {
          orgName,
          projectName,
          accessToken,
          lookbackMonths
      };

      const adoService = new AdoService(undefined, this.context);
      const embeddingService = new AdoEmbeddingService(undefined, this.context);

      await adoService.startSync(adoConfig, async () => {
        // Complete callback: update last sync time and start embeddings
        const syncTime = new Date().toISOString();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.ado) {
          settings.state.config.ado.lastSyncTime = syncTime;
          settings.state.config.ado.isSyncing = false;
          settings.state.config.ado.isIndexing = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }

        console.log('🔄 Auto-sync ADO: item sync complete, starting embedding indexing...');

        await embeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);

        // Reset isIndexing after embeddings complete so future scheduled syncs aren't blocked
        const updatedSettings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (updatedSettings?.state?.config?.ado) {
          updatedSettings.state.config.ado.isIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, updatedSettings);
        }
        this.syncStartedAt = undefined;
        console.log('✅ Auto-sync ADO: complete');
      }, false, (error: Error) => {
        // Error callback: reset flags so future scheduled syncs aren't blocked
        console.error('❌ Auto-sync ADO: worker error:', error.message);
        this.resetSyncFlags();
      });

    } catch (e) {
      console.error('Automated ADO background sync failed:', e);
      await this.resetSyncFlags();
    }
  }
}
