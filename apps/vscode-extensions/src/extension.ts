import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { EXTENSION, MESSAGE_TYPES } from '../constants';
import { AnalyticsService } from './services/analyticsService';
import { ConfluenceSyncScheduler } from './services/confluence/confluenceSyncScheduler';
import { AdoSyncScheduler } from './services/ado/adoSyncScheduler';
import { ConfluenceEmbeddingService } from './services/confluence/confluenceEmbeddingService';

let analyticsService: AnalyticsService;
let syncScheduler: ConfluenceSyncScheduler;
let adoSyncScheduler: AdoSyncScheduler;
let embeddingService: ConfluenceEmbeddingService;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize analytics service
  analyticsService = new AnalyticsService(context);
  analyticsService.trackEvent('extension_activated');

  // Initialize and start background sync scheduler
  syncScheduler = new ConfluenceSyncScheduler(context);
  syncScheduler.start();

  // Initialize and start ADO sync scheduler
  adoSyncScheduler = new AdoSyncScheduler(context);
  adoSyncScheduler.start();

  // Eagerly initialize the search worker so the first chat query is fast
  embeddingService = new ConfluenceEmbeddingService(undefined, context);
  embeddingService.eagerInit();

  // Register WebViewProvider
  const webViewProvider = new WebViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EXTENSION.VIEW_TYPE,
      webViewProvider
    )
  );

  // Register the ask command
  let askDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_ASK,
    () => {
      analyticsService.trackEvent('command_ask_triggered');
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );
    }
  );

  // Register the new chat command
  let newChatDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_NEW_CHAT,
    () => {
      analyticsService.trackEvent('command_new_chat_triggered');
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      // Get the webview view and send a message to create a new chat
      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.NEW_CHAT });
      }
    }
  );

  // Register the settings command
  let settingsDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_SETTINGS,
    () => {
      analyticsService.trackEvent('command_settings_triggered');
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      // Get the webview view and send a message to show settings
      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.SHOW_SETTINGS });
      }
    }
  );

  context.subscriptions.push(askDisposable);
  context.subscriptions.push(newChatDisposable);
  context.subscriptions.push(settingsDisposable);

  // Register the history command
  let historyDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_HISTORY,
    () => {
      analyticsService.trackEvent('command_history_triggered');
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      // Get the webview view and send a message to show history
      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.SHOW_HISTORY });
      }
    }
  );
  context.subscriptions.push(historyDisposable);

  // Register the clear data command
  let clearDataDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_CLEAR_DATA,
    async () => {
      analyticsService.trackEvent('command_clear_data_triggered');
      const selection = await vscode.window.showWarningMessage(
        "Are you sure you want to clear all WorkspaceGPT data and cache? This cannot be undone.",
        { modal: true },
        "Yes, Clear Data"
      );

      if (selection === "Yes, Clear Data") {
        // Stop any active background schedulers
        if (syncScheduler) {
          syncScheduler.stop();
        }
        if (adoSyncScheduler) {
          adoSyncScheduler.stop();
        }
        
        // If webview is active, tell it to reset (handles explicit stop of embedding process and auth disconnection)
        const webviewView = webViewProvider.getWebviewView();
        if (webviewView) {
          await webViewProvider.sendMessage({ type: MESSAGE_TYPES.RESET });
        } else {
          // If webview is not active, clear directories and global state manually
          const { clearWorkspaceGPTData } = await import('./utils/clearData');
          await clearWorkspaceGPTData(context);
        }
        
        vscode.window.showInformationMessage("WorkspaceGPT: All data and cache cleared successfully.");
      }
    }
  );
  context.subscriptions.push(clearDataDisposable);
}

export async function deactivate() {
  // Stop background scheduler
  if (syncScheduler) {
    syncScheduler.stop();
  }

  if (adoSyncScheduler) {
    adoSyncScheduler.stop();
  }

  // Clean up search worker process
  if (embeddingService) {
    embeddingService.dispose();
  }

  // Flush analytics before deactivating
  await analyticsService?.flush();
}
