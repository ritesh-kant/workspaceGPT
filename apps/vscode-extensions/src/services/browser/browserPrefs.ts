import type * as vscode from 'vscode';

const KEY = 'workspacegpt.controlChrome';

/** The "Control Chrome" toggle in the composer's + menu. On by default; off keeps the browser tools out of every turn. */
export function isControlChromeEnabled(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(KEY, true);
}

export function setControlChromeEnabled(context: vscode.ExtensionContext, enabled: boolean): Thenable<void> {
  return context.globalState.update(KEY, enabled);
}
