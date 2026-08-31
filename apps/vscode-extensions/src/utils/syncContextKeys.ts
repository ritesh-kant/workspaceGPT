import * as vscode from 'vscode';
import { EXTENSION, STORAGE_KEYS } from '../../constants';

/**
 * Mirrors persisted toggles into VS Code `when`-clause context keys so
 * title-bar items can hide themselves declaratively instead of every command
 * handler re-checking settings. Covers:
 *  - `workspacegpt.deploymentEnabled` — the "Deployment pipeline" beta toggle,
 *    gates the Releases icon.
 *  - `workspacegpt.remoteMode` — true when the active workspace mode is
 *    `remote`, gates the Share-to-Chrome menu item (remote-only feature).
 *
 * Call on activation (initial state) and whenever settings are saved.
 */
export async function syncContextKeys(
  context: vscode.ExtensionContext,
): Promise<void> {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const isDeploymentEnabled = !!settings?.state?.config?.deployment?.isDeploymentEnabled;
  await vscode.commands.executeCommand(
    'setContext',
    EXTENSION.CONTEXT_DEPLOYMENT_ENABLED,
    isDeploymentEnabled,
  );
  // Share-to-Chrome is parked — see EXTENSION.CONTEXT_SHARE_ENABLED. Set
  // explicitly rather than left undefined so the `when` clause is unambiguous.
  await vscode.commands.executeCommand('setContext', EXTENSION.CONTEXT_SHARE_ENABLED, false);
}
