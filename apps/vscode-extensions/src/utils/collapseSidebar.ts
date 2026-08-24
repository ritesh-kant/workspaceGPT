import * as vscode from 'vscode';

/** Where the WorkspaceGPT view container currently lives in the workbench. */
export type SidebarDock = 'left' | 'right' | 'bottom';

/**
 * VS Code exposes no API for a view's minimum width, and no single "close the
 * bar that hosts me" command — each workbench area has its own. The view is
 * contributed to the activity bar, so the primary sidebar is the default
 * target; `dock` only redirects when the user has dragged the view elsewhere.
 */
const CLOSE_COMMAND: Record<SidebarDock, string> = {
  left: 'workbench.action.closeSidebar',
  right: 'workbench.action.closeAuxiliaryBar',
  bottom: 'workbench.action.closePanel',
};

/**
 * Hide the workbench area hosting the WorkspaceGPT view. Called when the
 * webview reports it was dragged below `SIDEBAR_MIN_WIDTH_PX`, so the view
 * snaps shut instead of rendering a broken layout.
 */
export async function collapseWorkspaceGptSidebar(dock?: SidebarDock): Promise<void> {
  const command = CLOSE_COMMAND[dock ?? 'left'] ?? CLOSE_COMMAND.left;
  try {
    await vscode.commands.executeCommand(command);
  } catch (error) {
    // Never let a layout nicety surface as an error to the user.
    console.error(`WorkspaceGPT: failed to collapse sidebar via ${command}`, error);
  }
}
