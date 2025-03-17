import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext) {
    // Register ChatViewProvider
    const chatViewProvider = new ChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('workspacegpt.chatView', chatViewProvider)
    );

    // Register the command
    let disposable = vscode.commands.registerCommand('workspacegpt.ask', () => {
        // Focus on the chat view when command is triggered
        vscode.commands.executeCommand('workbench.view.extension.workspacegpt-sidebar');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}