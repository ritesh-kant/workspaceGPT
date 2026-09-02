import * as vscode from 'vscode';
import { AdoService, AdoConfig } from './adoService';
import { AdoAuthService } from './adoAuthService';
import { AdoEmbeddingService } from './adoEmbeddingService';
import { EmbeddingConfig } from '../../types/types';
import { MODEL, STORAGE_KEYS, SYNC_INTERVAL_MS } from '../../../constants';

export class AdoSyncScheduler {
  private intervalId?: NodeJS.Timeout;
  // Only set when THIS scheduler instance started a sync. Always undefined on a fresh
  // extension start, which is how we distinguish a post-restart stale flag from an
  // in-flight sync started by the current process.
  private syncStartedAt?: number;

  constructor(private readonly context: vscode.ExtensionContext) {}

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
      const adoConfig = config?.state?.config?.ado;
      if (!adoConfig?.isAuthenticated || !adoConfig?.orgName || !adoConfig?.projectName) {
        return;
      }

      const wasStuckSyncing = adoConfig.isSyncing;
      const wasStuckIndexing = adoConfig.isIndexing;

      if (wasStuckSyncing || wasStuckIndexing) {
        console.log(`🔁 ADO: detected stale flags on restart (isSyncing=${wasStuckSyncing}, isIndexing=${wasStuckIndexing}) — clearing`);
        adoConfig.isSyncing = false;
        adoConfig.isIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      if (wasStuckIndexing) {
        // Embedding process was running when extension was killed — signal webview to resume
        adoConfig._needsResumeIndexing = true;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      if (wasStuckSyncing) {
        // Check if sync was mid-way (not yet complete)
        const syncProgress = this.context.globalState.get<{ isComplete: boolean }>(STORAGE_KEYS.ADO_SYNC_PROGRESS);
        if (syncProgress && !syncProgress.isComplete) {
          console.log('🔁 ADO: previous sync was interrupted — will resume on next checkAndSync');
          adoConfig._needsResume = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      }
    } catch (err) {
      console.error('ADO restart recovery failed:', err);
    }
  }

  private async checkAndSync(force: boolean = false) {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      if (!config?.state?.config?.ado?.isAuthenticated || !config?.state?.config?.ado?.orgName || !config?.state?.config?.ado?.projectName) {
        return; // Not fully configured yet
      }

      // If a live sync is already running in this process instance, skip.
      if (this.syncStartedAt) {
        console.log('⏳ Auto-sync ADO: skipped — scheduler sync already in progress');
        return;
      }

      // Skip if a user-triggered sync or indexing is actively running.
      // Stale flags from a previous crashed session are cleared exactly once in
      // handleRestartRecovery() at startup, so anything still true here is live.
      if (config.state.config.ado.isSyncing || config.state.config.ado.isIndexing) {
        console.log('⏳ Auto-sync ADO: skipped — user sync/indexing already in progress');
        return;
      }

      // Check if we need to resume an interrupted sync
      if (config.state.config.ado._needsResume) {
        const syncProgress = this.context.globalState.get<{ isComplete: boolean }>(STORAGE_KEYS.ADO_SYNC_PROGRESS);
        if (syncProgress && !syncProgress.isComplete) {
          console.log('🔁 Auto-sync ADO: resuming interrupted sync...');
          config.state.config.ado._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
          await this.runSync(true);
          return;
        } else {
          // Progress is complete or missing, clear the flag and fall through to normal sync
          config.state.config.ado._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
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
        await this.runSync(false);
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

  private async runSync(resume: boolean = false) {
    try {
      const authService = new AdoAuthService(this.context);
      const authHeader = await authService.getValidAuthHeader();
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const orgName = config?.state?.config?.ado?.orgName;
      const projectName = config?.state?.config?.ado?.projectName;
      const lookbackMonths = config?.state?.config?.ado?.lookbackMonths || 24;

      if (!authHeader || !orgName || !projectName) {
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
          authHeader,
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
      }, resume, (error: Error) => {
        // Error callback: reset flags so future scheduled syncs aren't blocked
        console.error('❌ Auto-sync ADO: worker error:', error.message);
        this.resetSyncFlags();
      }, () => authService.getValidAuthHeader());

    } catch (e) {
      console.error('Automated ADO background sync failed:', e);
      await this.resetSyncFlags();
    }
  }
}
