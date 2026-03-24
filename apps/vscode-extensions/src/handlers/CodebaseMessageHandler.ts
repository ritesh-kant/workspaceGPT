import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { CodebaseService } from '../services/codebaseService';
import { CodebaseConfig } from '../types/types';
import { AnalyticsService } from '../services/analyticsService';

export class CodebaseMessageHandler {
  private codebaseService: CodebaseService;
  private codebaseConfig?: CodebaseConfig;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.codebaseService = new CodebaseService(this.webviewView, this.context);
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.START_CODEBASE_SYNC:
        this.analyticsService.trackEvent('codebase_sync_started');
        await this.handleStartCodebaseSync();
        return true;
      case MESSAGE_TYPES.RESUME_CODEBASE_SYNC:
        this.analyticsService.trackEvent('codebase_sync_resumed');
        await this.handleResumeCodebaseSync();
        return true;
      case MESSAGE_TYPES.STOP_CODEBASE_SYNC:
        this.analyticsService.trackEvent('codebase_sync_stopped');
        await this.handleStopCodebaseSync();
        return true;
    }
    return false;
  }

  public async reset(): Promise<void> {
    this.codebaseService.stopSync();
  }

  private async handleStartCodebaseSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.codebaseConfig = config.state.config.codebase;
      const repoName = this.codebaseConfig?.repoPath.split('/').slice(-1)[0];

      if (!this.isCodebaseConfigValid(this.codebaseConfig) || !this.codebaseConfig || !repoName) {
        throw new Error('Codebase configuration is incomplete. Please check your settings.');
      }
      await this.codebaseService.startSync(this.codebaseConfig, () =>
        this.handleCompleteCodebaseSync(repoName)
      );
    } catch (error) {
      console.error('Error in Codebase sync:', error);
      this.analyticsService.trackEvent('codebase_sync_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleResumeCodebaseSync(): Promise<void> {
    try {
      const config: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      this.codebaseConfig = config.state.config.codebase;
      const repoName = this.codebaseConfig?.repoPath.split('/').slice(-1)[0];

      if (!this.isCodebaseConfigValid(this.codebaseConfig) || !this.codebaseConfig || !repoName) {
        throw new Error('Codebase configuration is incomplete. Please check your settings.');
      }

      const progress = this.codebaseService.getSyncProgress();
      if (!progress || progress.isComplete) {
        await this.handleStartCodebaseSync();
        return;
      }

      await this.codebaseService.startSync(
        this.codebaseConfig,
        () => this.handleCompleteCodebaseSync(repoName),
        true
      );
    } catch (error) {
      console.error('Error resuming Codebase sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStopCodebaseSync(): Promise<void> {
    try {
      this.codebaseService.stopSync();

      const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (config?.state?.config?.codebase) {
        config.state.config.codebase.isSyncing = false;
        config.state.config.codebase.isIndexing = false;
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
      }
    } catch (error) {
      console.error('Error stopping codebase sync:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCompleteCodebaseSync(repoName: string): Promise<void> {
    try {
      await this.codebaseService.createEmbeddings(false, repoName);
    } catch (error) {
      console.error('Error in Codebase embedding:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SYNC_CODEBASE_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private isCodebaseConfigValid(config: any): boolean {
    return !!(config && config.repoPath);
  }
}
