import * as vscode from 'vscode';
import { EXTENSION, STORAGE_KEYS } from '../../constants';

// Settings are saved far more often than these toggles change (every sync
// progress tick), so a key is only set when its value differs from last time.
const lastSet = new Map<string, unknown>();

async function setContextIfChanged(key: string, value: unknown): Promise<void> {
  if (lastSet.has(key) && lastSet.get(key) === value) return;
  lastSet.set(key, value);
  await vscode.commands.executeCommand('setContext', key, value);
}

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
  await setContextIfChanged(EXTENSION.CONTEXT_DEPLOYMENT_ENABLED, isDeploymentEnabled);
  // Share-to-Chrome is parked — see EXTENSION.CONTEXT_SHARE_ENABLED. Set
  // explicitly rather than left undefined so the `when` clause is unambiguous.
  await setContextIfChanged(EXTENSION.CONTEXT_SHARE_ENABLED, false);
}
