import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';

export function activate(context: vscode.ExtensionContext) {
    // Register WebViewProvider
    const webViewProvider = new WebViewProvider(context.extensionUri, context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('workspacegpt.chatView', webViewProvider)
    );

    // Register the command
    let disposable = vscode.commands.registerCommand('workspacegpt.ask', () => {
        // Focus on the chat view when command is triggered
        vscode.commands.executeCommand('workbench.view.extension.workspacegpt-sidebar');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}