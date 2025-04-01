import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { EXTENSION, STORAGE_KEYS, MESSAGE_TYPES } from '../constants';
import { ChatService } from './services/chatService';

export async function activate(context: vscode.ExtensionContext) {
  // Register WebViewProvider
  const webViewProvider = new WebViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EXTENSION.VIEW_TYPE,
      webViewProvider
    )
  );

  // Initialize the model immediately
  const modelId = context.globalState.get<string>(STORAGE_KEYS.DEFAULT_MODEL) || STORAGE_KEYS.DEFAULT_MODEL;

  // Show notification that model is being downloaded
  vscode.window.setStatusBarMessage(
    `Downloading ${modelId.split('/')[1]} model...`,
    3000
  );

  // Start model download in the background
  downloadModelInBackground(modelId, context, webViewProvider);

  // Register the command
  let disposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_ASK,
    () => {
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );
    }
  );

  context.subscriptions.push(disposable);
}

async function downloadModelInBackground(
  modelId: string,
  context: vscode.ExtensionContext,
  webViewProvider: WebViewProvider
) {
  try {
    // We'll download the model in the background and notify webview when it's ready
    const view = webViewProvider.getWebviewView();
    if (view) {
      // If webview is already available, start download
      const chatService = new ChatService(view, context);
      await chatService.initializeModel(modelId);
    } else {
      // Wait for the webview to be created and then start download
      // Use event to track when webview is ready
      context.subscriptions.push(
        vscode.window.onDidChangeVisibleTextEditors(() => {
          const currentView = webViewProvider.getWebviewView();
          if (currentView) {
            const chatService = new ChatService(currentView, context);
            chatService.initializeModel(modelId).catch((error) => {
              console.error('Error initializing model:', error);
            });
          }
        })
      );
    }
  } catch (error) {
    console.error('Error downloading model:', error);
    vscode.window.showErrorMessage(
      `Failed to download model: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function deactivate() {}
