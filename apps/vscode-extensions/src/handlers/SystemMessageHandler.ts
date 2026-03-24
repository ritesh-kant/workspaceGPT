import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { clearWorkspaceGPTData } from 'src/utils/clearData';
import { AnalyticsService } from '../services/analyticsService';

export class SystemMessageHandler {
  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {}

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.UPDATE_GLOBAL_STATE:
        await this.updateGlobalState(data);
        return true;
      case MESSAGE_TYPES.GET_GLOBAL_STATE:
        await this.getGlobalState(data);
        return true;
      case MESSAGE_TYPES.CLEAR_GLOBAL_STATE:
        await this.handleClearGlobalState();
        return true;
      case MESSAGE_TYPES.SHOW_SETTINGS:
        this.analyticsService.trackEvent('settings_opened');
        await this.handleShowSettings();
        return true;
      case MESSAGE_TYPES.GET_WORKSPACE_PATH:
        await this.handleGetWorkspacePath();
        return true;
    }
    return false;
  }

  public async reset(): Promise<void> {
    try {
      await clearWorkspaceGPTData(this.context);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.RESET,
      });
      console.log('WorkspaceGPT storage reset.');
    } catch (error) {
      console.error('Error during WorkspaceGPT reset:', error);
    }
  }

  private async updateGlobalState(data: any): Promise<void> {
    await this.context.globalState.update(data.key, data.state);
  }

  private async getGlobalState(data: any): Promise<void> {
    const config: any = this.context.globalState.get(data.key);
    this.webviewView.webview.postMessage({
      type: MESSAGE_TYPES.GET_GLOBAL_STATE_RESPONSE,
      key: data.key,
      state: config?.state,
    });
  }

  private async handleClearGlobalState(): Promise<void> {
    try {
      const keys = this.context.globalState.keys();
      for (const key of keys) {
        await this.context.globalState.update(key, undefined);
      }
    } catch (error) {
      console.error('Error clearing global state:', error);
      throw error;
    }
  }

  private async handleShowSettings(): Promise<void> {
    try {
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.SHOW_SETTINGS,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Error showing settings: ${errorMessage}`);
    }
  }

  private async handleGetWorkspacePath(): Promise<void> {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;

      if (workspaceFolders && workspaceFolders.length > 0) {
        const workspacePath = workspaceFolders[0].uri.fsPath;

        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.WORKSPACE_PATH,
          path: workspacePath,
        });

        const config = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
        if (config?.state?.config?.codebase) {
          config.state.config.codebase.repoPath = workspacePath;
          await this.context.globalState.update(STORAGE_KEYS.SETTINGS, config);
        }
      } else {
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.WORKSPACE_PATH,
          path: '',
          error: 'No workspace is open',
        });
      }
    } catch (error) {
      console.error('Error getting workspace path:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.WORKSPACE_PATH,
        path: '',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
