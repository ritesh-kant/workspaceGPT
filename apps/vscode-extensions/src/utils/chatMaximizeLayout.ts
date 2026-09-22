import * as vscode from 'vscode';

/**
 * Workbench commands Copilot-style maximize uses. Verified against VS Code
 * `editorActions.ts` / `auxiliaryBarActions.ts`:
 *  - `maximizeEditorHideSidebar` hides the primary + secondary side bars and
 *    `arrangeGroups(MAXIMIZE)` so other editor *groups* disappear.
 *  - A new empty group is required first: maximizing the *active* group does
 *    not hide sibling tabs in that same group.
 *  - Unmaximize does not re-show side bars; the caller must reveal the chat
 *    view itself. Maximize then re-opens Sessions in the same WorkspaceGPT
 *    primary-sidebar container (one activity-bar icon). Restore reveals chat.
 */
const LAYOUT = {
  NEW_GROUP_RIGHT: 'workbench.action.newGroupRight',
  MAXIMIZE_HIDE_SIDEBARS: 'workbench.action.maximizeEditorHideSidebar',
  TOGGLE_MAXIMIZE_GROUP: 'workbench.action.toggleMaximizeEditorGroup',
  CLOSE_PANEL: 'workbench.action.closePanel',
  CLOSE_AUXILIARY_BAR: 'workbench.action.closeAuxiliaryBar',
} as const;

export async function tryExecuteCommand(command: string): Promise<boolean> {
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}

/** Empty group to the right so the chat webview is the only tab in it. */
export async function openEmptyEditorGroup(): Promise<void> {
  await tryExecuteCommand(LAYOUT.NEW_GROUP_RIGHT);
}

/**
 * After the chat webview is the active editor: hide the panel and auxiliary
 * bar, then maximize this editor group. The caller re-opens Sessions on the
 * left (primary sidebar) after this returns.
 */
export async function maximizeChatWorkbench(): Promise<void> {
  await tryExecuteCommand(LAYOUT.CLOSE_PANEL);
  await tryExecuteCommand(LAYOUT.CLOSE_AUXILIARY_BAR);
  const maximized = await tryExecuteCommand(LAYOUT.MAXIMIZE_HIDE_SIDEBARS);
  if (!maximized) {
    await tryExecuteCommand(LAYOUT.TOGGLE_MAXIMIZE_GROUP);
  }
}

export async function unmaximizeChatWorkbench(): Promise<void> {
  await tryExecuteCommand(LAYOUT.TOGGLE_MAXIMIZE_GROUP);
}

/**
 * Closes any editor groups that have no open tabs, so a temporary group created
 * for the chat webview doesn't linger as an empty split screen after restore.
 */
export async function closeEmptyEditorGroups(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  const groups = vscode.window.tabGroups.all;
  const emptyGroups = groups.filter((g) => g.tabs.length === 0);
  if (emptyGroups.length > 0 && groups.length > emptyGroups.length) {
    try {
      await vscode.window.tabGroups.close(emptyGroups);
    } catch {
      await tryExecuteCommand('workbench.action.closeGroup');
    }
  }
}
