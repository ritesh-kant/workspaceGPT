import * as fs from 'fs';
import * as os from 'os';
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

const DEFAULT_FOLDER_KEY = 'workspacegpt.defaultFolder';
const PENDING_START_KEY = 'workspacegpt.pendingFolderStart';
/** A start older than this was not followed by the reload it was saved for. */
const PENDING_START_TTL_MS = 2 * 60 * 1000;

/** The folder ticket work opens in (Settings → Default folder); undefined when unset or gone. */
export function getDefaultFolder(context: vscode.ExtensionContext): string | undefined {
  const stored = context.globalState.get<string>(DEFAULT_FOLDER_KEY);
  return stored && isDirectory(stored) ? stored : undefined;
}

/** Stores `folder` (`~` expanded) as the default folder, or clears it when undefined. */
export async function setDefaultFolder(context: vscode.ExtensionContext, folder: string | undefined): Promise<void> {
  if (!folder?.trim()) {
    await context.globalState.update(DEFAULT_FOLDER_KEY, undefined);
    return;
  }
  const resolved = path.resolve(folder.trim().replace(/^~(?=$|[\\/])/, process.env.HOME ?? '~'));
  if (!isDirectory(resolved)) throw new Error(`"${folder}" is not a folder.`);
  await context.globalState.update(DEFAULT_FOLDER_KEY, resolved);
}

/**
 * Opening a folder ends this extension host, so a ticket the user started is
 * saved here first and handed to the page that loads in `folder`.
 */
export async function savePendingStart(context: vscode.ExtensionContext, folder: string, start: unknown): Promise<void> {
  await context.globalState.update(PENDING_START_KEY, { folder: path.resolve(folder), start, savedAt: Date.now() });
}

/** The saved start, once, and only in the folder it was saved for. */
export async function takePendingStart(context: vscode.ExtensionContext, currentFolder: string | undefined): Promise<unknown> {
  const pending = context.globalState.get<{ folder: string; start: unknown; savedAt: number }>(PENDING_START_KEY);
  if (!pending) return undefined;
  await context.globalState.update(PENDING_START_KEY, undefined);
  const fresh = Date.now() - pending.savedAt < PENDING_START_TTL_MS;
  return fresh && currentFolder && path.resolve(currentFolder) === pending.folder ? pending.start : undefined;
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

/**
 * The folder of a linked worktree for `branch`, created if there is none yet
 * (new branch from HEAD when `create`). Lives under ~/.workspacegpt/worktrees
 * so the repo itself stays clean. Uncommitted changes stay where they are:
 * a worktree starts from the branch's commit.
 */
export async function ensureWorktree(cwd: string, branch: string, create: boolean): Promise<string> {
  const name = branch.trim();
  if (!name) throw new Error('Branch name is empty.');
  await git(cwd, ['check-ref-format', '--branch', name]).catch(() => {
    throw new Error(`"${name}" is not a valid branch name.`);
  });
  if (!create) {
    // Already checked out in a worktree (not the one we are in): open that one.
    const listing = await git(cwd, ['worktree', 'list', '--porcelain']);
    for (const block of listing.split('\n\n')) {
      const dir = /^worktree (.+)$/m.exec(block)?.[1];
      const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (dir && ref === name && path.resolve(dir) !== path.resolve(cwd) && isDirectory(dir)) return dir;
    }
  }
  const commonDir = path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir']));
  const repo = path.basename(path.dirname(commonDir));
  const dir = path.join(os.homedir(), '.workspacegpt', 'worktrees', repo, name.replace(/[\\/:]+/g, '-'));
  if (isDirectory(dir)) throw new Error(`${dir} already exists. Remove it or pick another branch name.`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(cwd, create ? ['worktree', 'add', '-b', name, dir] : ['worktree', 'add', dir, name]);
  return dir;
}
