import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { git } from './gitStatusService';

/**
 * The new-chat screen's folder and branch chips (webview WorkspaceControls.tsx).
 * Folders open through VS Code's own commands, so the desktop host only has to
 * implement those commands (apps/desktop/sidecar/vscode-compat/commands.ts).
 */

const RECENT_FOLDERS_KEY = 'workspacegpt.recentFolders';
const MAX_RECENT_FOLDERS = 10;

/** Most recent first; folders that no longer exist are left out. */
export function getRecentFolders(context: vscode.ExtensionContext): string[] {
  const stored = context.globalState.get<string[]>(RECENT_FOLDERS_KEY) ?? [];
  return stored.filter((p) => isDirectory(p));
}

/** Called on activation with the open folder, so the list is every folder the app has worked in. */
export async function recordRecentFolder(context: vscode.ExtensionContext, folder: string | undefined): Promise<void> {
  if (!folder) return;
  const stored = context.globalState.get<string[]>(RECENT_FOLDERS_KEY) ?? [];
  const next = [folder, ...stored.filter((p) => p !== folder)].slice(0, MAX_RECENT_FOLDERS);
  await context.globalState.update(RECENT_FOLDERS_KEY, next);
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Opens `folder`, or the system folder picker when it is undefined. VS Code
 * reloads the window; the desktop restarts its sidecar. Either way this
 * extension host ends, so nothing after it runs.
 */
export async function openFolder(folder: string | undefined): Promise<void> {
  if (folder === undefined) {
    await vscode.commands.executeCommand('workbench.action.files.openFolder');
    return;
  }
  const resolved = path.resolve(folder.replace(/^~(?=$|[\\/])/, process.env.HOME ?? '~'));
  if (!isDirectory(resolved)) throw new Error(`"${folder}" is not a folder.`);
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(resolved));
}

export async function listBranches(cwd: string): Promise<{ current?: string; branches: string[] }> {
  const [current, refs] = await Promise.all([
    git(cwd, ['branch', '--show-current']).catch(() => ''),
    // Most recently committed first: the branch someone wants is usually recent.
    git(cwd, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']),
  ]);
  return { current: current || undefined, branches: refs.split('\n').filter(Boolean) };
}

/**
 * Checks out `branch`, or creates it from HEAD. Switching to an existing
 * branch is refused while tracked files have uncommitted changes: git would
 * either carry them across or refuse halfway, and neither is what a click on
 * a branch name should do. Creating a branch keeps the changes, so it is allowed.
 */
export async function switchBranch(cwd: string, branch: string, create: boolean): Promise<void> {
  const name = branch.trim();
  if (!name) throw new Error('Branch name is empty.');
  await git(cwd, ['check-ref-format', '--branch', name]).catch(() => {
    throw new Error(`"${name}" is not a valid branch name.`);
  });
  if (create) {
    await git(cwd, ['switch', '-c', name]);
    return;
  }
  const dirty = await git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    const count = dirty.split('\n').length;
    throw new Error(
      `${count} file${count === 1 ? ' has' : 's have'} uncommitted changes. Commit or stash them before switching branches.`
    );
  }
  await git(cwd, ['switch', name]);
}
