import * as vscode from 'vscode';
import * as path from 'path';
import { deleteDirectory } from './deleteDirectory';

export async function clearWorkspaceGPTData(context: vscode.ExtensionContext) {
  try {
    // 1. Delete storage directories for all integrations
    const directoriesToDelete = ['confluence', 'ado', 'codebase', 'chat_history'];
    for (const dir of directoriesToDelete) {
      const dirPath = path.join(context.globalStorageUri.fsPath, dir);
      await deleteDirectory(dirPath);
    }

    // 2. Clear entire global state
    const keys = context.globalState.keys();
    for (const key of keys) {
      await context.globalState.update(key, undefined);
    }
    
    console.log('WorkspaceGPT data and cache cleared entirely.');
  } catch (error) {
    console.error('Error during WorkspaceGPT data clear:', error);
  }
}
