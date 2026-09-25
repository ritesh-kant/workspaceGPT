import * as vscode from 'vscode';
import { AdoService, AdoConfig } from './adoService';
import { AdoAuthService } from './adoAuthService';
import { AdoEmbeddingService } from './adoEmbeddingService';
import { EmbeddingConfig } from '../../types/types';
import { MODEL, STORAGE_KEYS, SYNC_INTERVAL_MS } from '../../../constants';
import { publishSyncState } from '../../utils/syncStateStore';

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

      // Stop in the settings panel ends a scheduler run without firing either
      // callback (it reaches the same worker). Once the persisted flags are
      // down, that run is over and must not block the next one.
      const adoFlags = config.state.config.ado;
      if (this.syncStartedAt && !adoFlags.isSyncing && !adoFlags.isIndexing) {
        this.syncStartedAt = undefined;
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
          // runSync indexes when the sync completes, so this covers indexing too.
          config.state.config.ado._needsResumeIndexing = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
          await this.runSync(true);
          return;
        } else {
          // Progress is complete or missing, clear the flag and fall through to normal sync
          config.state.config.ado._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      }

      // Indexing the restart cut short. Resumed here, not when the webview
      // resolves: the desktop resolves its view straight after activate(),
      // before handleRestartRecovery() sets this flag, so that resume never
      // ran and the source sat at "Indexing unfinished".
      if (config.state.config.ado._needsResumeIndexing) {
        config.state.config.ado._needsResumeIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        await this.resumeIndexing();
        return;
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

  private async resumeIndexing() {
    console.log('🔁 Auto-sync ADO: resuming interrupted indexing...');
    // Mark in flight before forking, as the panel's resume does, so a tick in
    // between can't start a sync over it. The embedding service clears it on
    // the worker's terminal message.
    await publishSyncState(this.context, 'ado', { isIndexing: true });
    await new AdoEmbeddingService(undefined, this.context).createEmbeddings(
      { dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS } as EmbeddingConfig,
      true
    );
  }

  private async resetSyncFlags() {
    await publishSyncState(this.context, 'ado', {
      isSyncing: false,
      isIndexing: false,
    });
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

      // Pushed to the panel: this run's services report progress to it and
      // share their worker with its Stop button.
      await publishSyncState(this.context, 'ado', { isSyncing: true });
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
        // Complete callback: update last sync time and start embeddings.
        // Pushed to the webview so the settings panel's "synced Nh ago" label
        // reflects this run instead of staying frozen at what it hydrated with.
        await publishSyncState(this.context, 'ado', {
          lastSyncTime: new Date().toISOString(),
          isSyncing: false,
          isIndexing: true,
        });

        console.log('🔄 Auto-sync ADO: item sync complete, starting embedding indexing...');

        // Returns once the embedding worker is forked, not once it finishes —
        // AdoEmbeddingService clears isIndexing from the worker's
        // completion/error message.
        await embeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);

        this.syncStartedAt = undefined;
        console.log('✅ Auto-sync ADO: item sync complete, indexing running');
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
