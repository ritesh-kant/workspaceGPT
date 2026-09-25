import * as vscode from 'vscode';
import { JiraService, JiraSyncConfig } from './jiraService';
import { JiraAuthService, jiraApiBase } from './jiraAuthService';
import { JiraEmbeddingService } from './jiraEmbeddingService';
import { EmbeddingConfig } from '../../types/types';
import { MODEL, STORAGE_KEYS, SYNC_INTERVAL_MS } from '../../../constants';
import { persistSyncState, publishSyncState } from '../../utils/syncStateStore';

/** Background sync scheduling — mirrors AdoSyncScheduler exactly, see docs/design/jira.md §5 P5. */
export class JiraSyncScheduler {
  private intervalId?: NodeJS.Timeout;
  private syncStartedAt?: number;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public start() {
    this.intervalId = setInterval(() => this.checkAndSync(), SYNC_INTERVAL_MS);
    this.handleRestartRecovery().then(() => this.checkAndSync());
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private async handleRestartRecovery(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const jiraConfig = config?.state?.config?.jira;
      if (!jiraConfig?.isAuthenticated || !jiraConfig?.siteUrl || !jiraConfig?.projectKey) {
        return;
      }

      const wasStuckSyncing = jiraConfig.isSyncing;
      const wasStuckIndexing = jiraConfig.isIndexing;

      if (wasStuckSyncing || wasStuckIndexing) {
        console.log(`🔁 Jira: detected stale flags on restart (isSyncing=${wasStuckSyncing}, isIndexing=${wasStuckIndexing}) — clearing`);
        jiraConfig.isSyncing = false;
        jiraConfig.isIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      if (wasStuckIndexing) {
        jiraConfig._needsResumeIndexing = true;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }

      if (wasStuckSyncing) {
        const syncProgress = this.context.globalState.get<{ isComplete: boolean }>(STORAGE_KEYS.JIRA_SYNC_PROGRESS);
        if (syncProgress && !syncProgress.isComplete) {
          console.log('🔁 Jira: previous sync was interrupted — will resume on next checkAndSync');
          jiraConfig._needsResume = true;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      }
    } catch (err) {
      console.error('Jira restart recovery failed:', err);
    }
  }

  private async checkAndSync(force: boolean = false) {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      if (!config?.state?.config?.jira?.isAuthenticated || !config?.state?.config?.jira?.siteUrl || !config?.state?.config?.jira?.projectKey) {
        return; // Not fully configured yet
      }

      if (this.syncStartedAt) {
        console.log('⏳ Auto-sync Jira: skipped — scheduler sync already in progress');
        return;
      }

      if (config.state.config.jira.isSyncing || config.state.config.jira.isIndexing) {
        console.log('⏳ Auto-sync Jira: skipped — user sync/indexing already in progress');
        return;
      }

      if (config.state.config.jira._needsResume) {
        const syncProgress = this.context.globalState.get<{ isComplete: boolean }>(STORAGE_KEYS.JIRA_SYNC_PROGRESS);
        if (syncProgress && !syncProgress.isComplete) {
          console.log('🔁 Auto-sync Jira: resuming interrupted sync...');
          config.state.config.jira._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
          await this.runSync(true);
          return;
        } else {
          config.state.config.jira._needsResume = false;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      }

      const lastSyncTimeStr = config.state.config.jira.lastSyncTime;
      if (!lastSyncTimeStr) {
        return; // Never synced before, don't auto-sync
      }

      const lastSyncTime = new Date(lastSyncTimeStr).getTime();
      const now = Date.now();
      const elapsed = now - lastSyncTime;

      if (force || elapsed >= SYNC_INTERVAL_MS) {
        console.log(`🔄 Triggering automated Jira background sync (force: ${force}, last sync ${Math.round(elapsed / 60000)} min ago)...`);
        await this.runSync(false);
      }
    } catch (err) {
      console.error('Jira background sync check failed:', err);
    }
  }

  private async resetSyncFlags() {
    await publishSyncState(this.context, 'jira', {
      isSyncing: false,
      isIndexing: false,
    });
    this.syncStartedAt = undefined;
  }

  private async runSync(resume: boolean = false) {
    try {
      const authService = new JiraAuthService(this.context);
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const projectKey = config?.state?.config?.jira?.projectKey;
      const lookbackMonths = config?.state?.config?.jira?.lookbackMonths || 24;
      const site = authService.getStoredSite();

      if (!site || !projectKey) {
        throw new Error('Jira config incomplete');
      }
      const authHeader = await authService.getValidAuthHeader();

      await persistSyncState(this.context, 'jira', { isSyncing: true });
      this.syncStartedAt = Date.now();

      const jiraSyncConfig: JiraSyncConfig = { siteUrl: site.url, apiBase: jiraApiBase(site.id), projectKey, authHeader, lookbackMonths };

      const jiraService = new JiraService(undefined, this.context);
      const embeddingService = new JiraEmbeddingService(undefined, this.context);

      await jiraService.startSync(
        jiraSyncConfig,
        async () => {
          await publishSyncState(this.context, 'jira', {
            lastSyncTime: new Date().toISOString(),
            isSyncing: false,
            isIndexing: true,
          });

          console.log('🔄 Auto-sync Jira: item sync complete, starting embedding indexing...');

          await embeddingService.createEmbeddings({
            dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
          } as EmbeddingConfig);

          this.syncStartedAt = undefined;
          console.log('✅ Auto-sync Jira: item sync complete, indexing running');
        },
        resume,
        (error: Error) => {
          console.error('❌ Auto-sync Jira: worker error:', error.message);
          this.resetSyncFlags();
        },
        () => authService.getValidAuthHeader()
      );
    } catch (e) {
      console.error('Automated Jira background sync failed:', e);
      await this.resetSyncFlags();
    }
  }
}
