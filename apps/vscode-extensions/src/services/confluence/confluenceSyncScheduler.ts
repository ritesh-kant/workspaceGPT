import * as vscode from 'vscode';
import { ConfluenceService, ConfluenceConfig } from './confluenceService';
import { ConfluenceAuthService } from './confluenceAuthService';
import { ConfluenceEmbeddingService } from './confluenceEmbeddingService';
import { EmbeddingConfig } from '../../types/types';
import { MODEL, STORAGE_KEYS, SYNC_INTERVAL_MS } from '../../../constants';
import { persistSyncState, publishSyncState } from '../../utils/syncStateStore';

export class ConfluenceSyncScheduler {
  private intervalId?: NodeJS.Timeout;
  private confluenceAuthService: ConfluenceAuthService;
  // Only set when THIS scheduler instance started a sync. Always undefined on a fresh
  // extension start, which is how we distinguish a post-restart stale flag from an
  // in-flight sync started by the current process.
  private syncStartedAt?: number;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.confluenceAuthService = new ConfluenceAuthService(context);
  }

  public start() {
    this.intervalId = setInterval(() => this.checkAndSync(), SYNC_INTERVAL_MS);
    // On start, first clear any stale in-progress flags left by a previous session,
    // then decide whether to resume or run an incremental sync.
    // Do not pass force=true — we only sync on startup if SYNC_INTERVAL_MS has
    // actually elapsed since the last sync, not on every extension restart.
    this.handleRestartRecovery().then(() => this.checkAndSync());
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  /**
   * Called once on start. If the persisted state has isSyncing/isIndexing=true but
   * syncStartedAt is undefined (we just restarted), those flags are stale from a
   * previous session. We clear them so the scheduler is not stuck forever. If sync
   * was mid-way (SyncProgress exists and !isComplete), we immediately trigger a
   * resume so data is not lost.
   */
  private async handleRestartRecovery(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const confluenceConfig = config?.state?.config?.confluence;
      if (!confluenceConfig?.isAuthenticated || !confluenceConfig?.spaceKey) {
        return;
      }

      const wasStuckSyncing = confluenceConfig.isSyncing;
      const wasStuckIndexing = confluenceConfig.isIndexing;

      if (wasStuckSyncing || wasStuckIndexing) {
        console.log(`🔁 Confluence: detected stale flags on restart (isSyncing=${wasStuckSyncing}, isIndexing=${wasStuckIndexing}) — clearing`);
        confluenceConfig.isSyncing = false;
        confluenceConfig.isIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      if (wasStuckIndexing) {
        // Embedding process was running when extension was killed — signal webview to resume
        confluenceConfig._needsResumeIndexing = true;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      if (wasStuckSyncing) {
        // Check if sync was mid-way (not yet complete)
        const syncProgress = this.context.globalState.get<{ isComplete: boolean }>(STORAGE_KEYS.CONFLUENCE_SYNC_PROGRESS);
        if (syncProgress && !syncProgress.isComplete) {
          console.log('🔁 Confluence: previous sync was interrupted — will resume on next checkAndSync');
          // Mark that a resume is needed so checkAndSync picks it up
          confluenceConfig._needsResume = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      }
    } catch (err) {
      console.error('Confluence restart recovery failed:', err);
    }
  }

  private async checkAndSync(force: boolean = false) {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      if (!config?.state?.config?.confluence?.isAuthenticated || !config?.state?.config?.confluence?.spaceKey) {
        return; // Not fully configured yet
      }

      // Skip if the scheduler itself already has a sync running.
      if (this.syncStartedAt) {
        console.log('⏳ Auto-sync: skipped — scheduler sync already in progress');
        return;
      }

      // Skip if a user-triggered sync or indexing is actively running.
      // Stale flags from a previous crashed session are cleared exactly once in
      // handleRestartRecovery() at startup, so anything still true here is live.
      if (config.state.config.confluence.isSyncing || config.state.config.confluence.isIndexing) {
        console.log('⏳ Auto-sync: skipped — user sync/indexing already in progress');
        return;
      }

      // Check if we need to resume an interrupted sync
      if (config.state.config.confluence._needsResume) {
        const syncProgress = this.context.globalState.get<{ isComplete: boolean }>(STORAGE_KEYS.CONFLUENCE_SYNC_PROGRESS);
        if (syncProgress && !syncProgress.isComplete) {
          console.log('🔁 Auto-sync: resuming interrupted Confluence sync...');
          config.state.config.confluence._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
          await this.runSync(true);
          return;
        } else {
          // Progress is complete or missing, clear the flag and fall through to normal sync
          config.state.config.confluence._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      }

      const lastSyncTimeStr = config.state.config.confluence.lastSyncTime;
      if (!lastSyncTimeStr) {
        return; // Never synced before, don't auto-sync
      }

      const lastSyncTime = new Date(lastSyncTimeStr).getTime();
      const now = Date.now();
      const elapsed = now - lastSyncTime;

      if (force || elapsed >= SYNC_INTERVAL_MS) {
        console.log(`🔄 Triggering automated background sync (force: ${force}, last sync ${Math.round(elapsed / 60000)} min ago)...`);
        await this.runSync(false);
      }
    } catch (err) {
      console.error('Background sync check failed:', err);
    }
  }

  private async resetSyncFlags() {
    await publishSyncState(this.context, 'confluence', {
      isSyncing: false,
      isIndexing: false,
    });
    this.syncStartedAt = undefined;
  }

  private async runSync(resume: boolean = false) {
    try {
      const accessToken = await this.confluenceAuthService.getValidAccessToken();
      const site = this.confluenceAuthService.getStoredSite();
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const spaceKey = config?.state?.config?.confluence?.spaceKey;

      if (!site || !accessToken || !spaceKey) {
          throw new Error('Confluence config incomplete');
      }

      // Mark the sync in-flight for our own re-entrancy guard, but don't push
      // it to the UI: this run reports no progress to the webview (the service
      // below is built without one), so the panel would show a stalled bar.
      await persistSyncState(this.context, 'confluence', { isSyncing: true });
      this.syncStartedAt = Date.now();

      const confluenceConfig: ConfluenceConfig = {
          cloudId: site.id,
          accessToken,
          spaceKey,
          siteUrl: site.url,
      };

      const confluenceService = new ConfluenceService(undefined, this.context);
      const embeddingService = new ConfluenceEmbeddingService(undefined, this.context);

      await confluenceService.startSync(confluenceConfig, async () => {
        // Complete callback: update last sync time and start embeddings.
        // Pushed to the webview so the settings panel's "synced Nh ago" label
        // reflects this run instead of staying frozen at what it hydrated with.
        await publishSyncState(this.context, 'confluence', {
          lastSyncTime: new Date().toISOString(),
          isSyncing: false,
          isIndexing: true,
        });

        console.log('🔄 Auto-sync: page sync complete, starting embedding indexing...');

        // Returns once the embedding worker is forked, not once it finishes —
        // ConfluenceEmbeddingService clears isIndexing from the worker's
        // completion/error message.
        await embeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);

        this.syncStartedAt = undefined;
        console.log('✅ Auto-sync: page sync complete, indexing running');
      }, resume, (error: Error) => {
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
