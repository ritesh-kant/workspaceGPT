import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { EXTENSION, MESSAGE_TYPES } from '../constants';

export async function activate(context: vscode.ExtensionContext) {
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
}

export function deactivate() {}
