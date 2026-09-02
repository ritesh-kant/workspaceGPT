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
 * How long after a reveal to ignore collapse requests. The webview resets its
 * own width baseline on reveal, but its measurements are polled, so a request
 * already in flight (or based on a pre-reveal frame) can land just after the
 * view opens. Anything that soon is layout settling, not a sash drag.
 */
const REVEAL_GRACE_MS = 1500;

let viewVisible = false;
let becameVisibleAt = 0;

/**
 * Only the host can see whether the view is actually on screen, so it owns the
 * gate for {@link collapseWorkspaceGptSidebar}. Called from the view provider
 * on resolve and on every visibility change.
 */
export function noteWorkspaceGptViewVisibility(visible: boolean): void {
  if (visible && !viewVisible) {
    becameVisibleAt = Date.now();
  }
  viewVisible = visible;
}

/**
 * Hide the workbench area hosting the WorkspaceGPT view. Called when the
 * webview reports it was dragged below `SIDEBAR_MIN_WIDTH_PX`, so the view
 * snaps shut instead of rendering a broken layout.
 *
 * Ignored unless the view is visible and has been for longer than the reveal
 * grace: a retained webview keeps measuring while another view owns the
 * sidebar, so a resize that happens off screen — or the first frames after the
 * icon is clicked at a narrow width — would otherwise close the bar the user
 * just opened, which reads as "the icon does nothing".
 */
export async function collapseWorkspaceGptSidebar(dock?: SidebarDock): Promise<void> {
  if (!viewVisible || Date.now() - becameVisibleAt < REVEAL_GRACE_MS) {
    return;
  }

  const command = CLOSE_COMMAND[dock ?? 'left'] ?? CLOSE_COMMAND.left;
  try {
    await vscode.commands.executeCommand(command);
  } catch (error) {
    // Never let a layout nicety surface as an error to the user.
    console.error(`WorkspaceGPT: failed to collapse sidebar via ${command}`, error);
  }
}
