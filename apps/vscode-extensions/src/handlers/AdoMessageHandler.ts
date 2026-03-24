import * as vscode from 'vscode';
import path from 'path';
import { MESSAGE_TYPES, MODEL, STORAGE_KEYS } from '../../constants';
import { AdoService, AdoConfig } from '../services/azure/adoService';
import { AdoAuthService } from '../services/azure/adoAuthService';
import { AdoEmbeddingService } from '../services/azure/adoEmbeddingService';
import { EmbeddingConfig } from '../types/types';
import { AnalyticsService } from '../services/analyticsService';
import { deleteDirectory } from 'src/utils/deleteDirectory';

export class AdoMessageHandler {
  private adoService: AdoService;
  private adoAuthService: AdoAuthService;
  private adoEmbeddingService: AdoEmbeddingService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.adoService = new AdoService(this.webviewView, this.context);
    this.adoAuthService = new AdoAuthService(this.context);
    this.adoEmbeddingService = new AdoEmbeddingService(this.webviewView, this.context);

    // Pre-warm ADO worker if connected
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    if (config?.state?.config?.ado?.config?.isAdoConnected) {
      console.log('Pre-warming ADO search worker...');
      this.adoEmbeddingService.ensureSearchWorker().catch(e => console.error('Failed to pre-warm ADO worker', e));
    }
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.SAVE_ADO_PAT:
        this.analyticsService.trackEvent('ado_pat_saved');
        await this.handleSaveAdoPat(data.pat);
        return true;
      case MESSAGE_TYPES.DISCONNECT_ADO:
        this.analyticsService.trackEvent('ado_disconnected');
        await this.handleDisconnectAdo();
        return true;
      case MESSAGE_TYPES.FETCH_ADO_PROJECTS:
        this.analyticsService.trackEvent('ado_projects_fetched');
        await this.handleFetchAdoProjects(data.orgName);
        return true;
      case MESSAGE_TYPES.CHECK_ADO_CONNECTION:
        await this.handleCheckAdoConnection();
        return true;
      case MESSAGE_TYPES.START_ADO_SYNC:
        this.analyticsService.trackEvent('ado_sync_started');
        await this.handleStartAdoSync(data.forceFull);
        return true;
      case MESSAGE_TYPES.RESUME_ADO_SYNC:
        this.analyticsService.trackEvent('ado_sync_resumed');
        await this.handleResumeAdoSync();
        return true;
      case MESSAGE_TYPES.STOP_ADO_SYNC:
        this.analyticsService.trackEvent('ado_sync_stopped');
        await this.handleStopAdoSync();
        return true;
      case MESSAGE_TYPES.RESUME_INDEXING_ADO:
        this.analyticsService.trackEvent('ado_indexing_resumed');
        await this.handleResumeIndexingAdo();
        return true;
    }
    return false;
  }

  public async reset(): Promise<void> {
    this.adoService.stopSync();
    this.adoEmbeddingService.stopEmbeddingProcess();
    await this.adoAuthService.disconnect();
    await this.adoService.resetSyncProgress();
    await this.adoEmbeddingService.resetEmbeddingProgress();
  }

  private async handleSaveAdoPat(pat: string): Promise<void> {
    try {
      if (!pat || pat.trim() === '') {
        throw new Error("Personal Access Token cannot be empty.");
      }
      await this.adoAuthService.savePat(pat);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_PAT_SUCCESS,
        profile: this.adoAuthService.getStoredProfile(),
      });
    } catch (error) {
      console.error('Error in ADO PAT Save:', error);
      this.analyticsService.trackEvent('ado_pat_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_PAT_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleDisconnectAdo(): Promise<void> {
    try {
      this.adoService.stopSync();
      this.adoEmbeddingService.stopEmbeddingProcess();

      await this.adoAuthService.disconnect();

      await this.adoService.resetSyncProgress();
      await this.adoEmbeddingService.resetEmbeddingProgress();

      const adoDirPath = path.join(
        this.context.globalStorageUri.fsPath,
        'ado'
      );
      await deleteDirectory(adoDirPath);

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.ado) {
        settings.state.config.ado = {
          ...settings.state.config.ado,
          isAuthenticated: false,
          orgName: '',
          projectName: '',
          isSyncing: false,
          isIndexing: false,
          canResume: false,
          canResumeIndexing: false,
          isSyncCompleted: false,
          isIndexingCompleted: false,
          adoSyncProgress: 0,
          adoIndexProgress: 0,
          lastSyncTime: '',
        };
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.DISCONNECT_ADO,
        success: true,
      });
    } catch (error) {
      console.error('Error disconnecting ADO:', error);
    }
  }

  private async handleFetchAdoProjects(orgName: string): Promise<void> {
    try {
      if (!orgName || orgName.trim() === '') {
        throw new Error('Organization name is required to fetch projects.');
      }
      const projects = await this.adoAuthService.fetchProjects(orgName.trim());
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_PROJECTS_SUCCESS,
        projects: projects.map(p => ({ id: p.id, name: p.name })),
      });
    } catch (error) {
      console.error('Error fetching ADO projects:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_ADO_PROJECTS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async getAdoConfig(): Promise<AdoConfig> {
    const accessToken = await this.adoAuthService.getValidAccessToken();
    const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const orgName = config?.state?.config?.ado?.orgName;
    const projectName = config?.state?.config?.ado?.projectName;

    const lookbackMonths = config?.state?.config?.ado?.lookbackMonths ?? 24;

    if (!accessToken || !orgName || !projectName) {
      throw new Error(
        'Azure DevOps configuration is incomplete. Please connect.'
      );
    }

    return {
      orgName,
      projectName,
      accessToken,
      lookbackMonths,
    };
  }

  private async handleCheckAdoConnection(): Promise<void> {
    try {
      const adoConfig = await this.getAdoConfig();
      const totalItems = await this.adoService.getTotalItems(adoConfig);

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to ADO. Found ${totalItems} items.`,
      });
    } catch (error) {
      this.analyticsService.trackEvent('ado_connection_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.ADO_CONNECTION_STATUS,
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async handleStartAdoSync(forceFull: boolean = false): Promise<void> {
    try {
      if (forceFull) {
        this.adoService.stopSync();
        await this.adoService.resetSyncProgress();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.ado) {
          settings.state.config.ado.lastSyncTime = '';
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }
      }

      const adoConfig = await this.getAdoConfig();

      await this.adoService.startSync(adoConfig, async () => {
        const lastSyncTime = new Date().toISOString();
        const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (settings?.state?.config?.ado) {
          settings.state.config.ado.lastSyncTime = lastSyncTime;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
        }
        this.handleCompleteAdoSync();
      });
    } catch (error) {
      console.error('Error in ADO sync:', error);
      this.analyticsService.trackEvent('ado_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeAdoSync(): Promise<void> {
    try {
      const adoConfig = await this.getAdoConfig();
      const progress = this.adoService.getSyncProgress();
      
      if (!progress || progress.isComplete) {
        await this.handleStartAdoSync();
        return;
      }

      await this.adoService.startSync(
        adoConfig,
        () => this.handleCompleteAdoSync(),
        true
      );
    } catch (error) {
      console.error('Error resuming ADO sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStopAdoSync(): Promise<void> {
    try {
      this.adoService.stopSync();
      this.adoEmbeddingService.stopEmbeddingProcess();

      const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (config?.state?.config?.ado) {
        config.state.config.ado.isSyncing = false;
        config.state.config.ado.isIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    } catch (error) {
      console.error('Error stopping ADO sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_ADO_STOP,
      });
    }
  }

  private async handleCompleteAdoSync(): Promise<void> {
    try {
      await this.adoEmbeddingService.createEmbeddings({
        dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
      } as EmbeddingConfig);
    } catch (error) {
      console.error('Error in ADO indexing:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeIndexingAdo(): Promise<void> {
    try {
      const progress = this.adoEmbeddingService.getEmbeddingProgress();
      if (!progress || progress.isComplete) {
        await this.adoEmbeddingService.createEmbeddings({
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig);
        return;
      }

      await this.adoEmbeddingService.createEmbeddings(
        {
          dimensions: MODEL.DEFAULT_TEXT_EMBEDDING_DIMENSIONS,
        } as EmbeddingConfig,
        true
      );
    } catch (error) {
      console.error('Error resuming ADO indexing:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.INDEXING_ADO_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
