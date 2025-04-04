import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { EXTENSION, STORAGE_KEYS, MESSAGE_TYPES, MODEL } from '../constants';
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

export function deactivate() {}
