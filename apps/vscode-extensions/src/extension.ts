import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { EXTENSION, MESSAGE_TYPES } from '../constants';
import { AnalyticsService } from './services/analyticsService';
import { ConfluenceSyncScheduler } from './services/confluenceSyncScheduler';
import { EmbeddingService } from './services/confluenceEmbeddingService';

let analyticsService: AnalyticsService;
let syncScheduler: ConfluenceSyncScheduler;
let embeddingService: EmbeddingService;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize analytics service
  analyticsService = new AnalyticsService(context);
  analyticsService.trackEvent('extension_activated');

  // Initialize and start background sync scheduler
  syncScheduler = new ConfluenceSyncScheduler(context);
  syncScheduler.start();

  // Eagerly initialize the search worker so the first chat query is fast
  embeddingService = new EmbeddingService(undefined, context);
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
}

export async function deactivate() {
  // Stop background scheduler
  if (syncScheduler) {
    syncScheduler.stop();
  }

  // Clean up search worker process
  if (embeddingService) {
    embeddingService.dispose();
  }

  // Flush analytics before deactivating
  await analyticsService?.flush();
}
