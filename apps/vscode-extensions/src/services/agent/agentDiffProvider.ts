import * as vscode from 'vscode';
import * as path from 'path';

/**
 * "Review" diff support for agent-changed files: before the first agent write
 * touches a file, its original content is recorded here; the webview's
 * files-changed bar can then open a native VS Code diff (original ⟷ current)
 * via a readonly TextDocumentContentProvider — the same review UX Cursor/
 * Antigravity give after an agent turn.
 *
 * Originals are per-session and keyed by fsPath: the FIRST time the agent
 * touches a file wins, so a multi-edit run reviews as one cumulative diff
 * against where the user started, not against the previous agent edit.
 */

const SCHEME = 'workspacegpt-original';

/** fsPath → file content before the agent's first write this session. */
const originals = new Map<string, string>();

let registered = false;

// Created on first use, not at import: this module is also loaded by the
// headless eval harness, whose vscode stub has no EventEmitter.
let changed: vscode.EventEmitter<string> | null = null;
const emitter = (): vscode.EventEmitter<string> => (changed ??= new vscode.EventEmitter<string>());
/** Subscribe to originals being added or rewritten (hunk lenses re-render). */
export function onOriginalsChanged(listener: (fsPath: string) => void): vscode.Disposable {
  return emitter().event(listener);
}

export function recordOriginalContent(fsPath: string, content: string): void {
  if (!originals.has(fsPath)) {
    originals.set(fsPath, content);
    changed?.fire(fsPath);
  }
}

export function hasOriginal(fsPath: string): boolean {
  return originals.has(fsPath);
}

export function getOriginalContent(fsPath: string): string | undefined {
  return originals.get(fsPath);
}

/** Rewrite the baseline — "keep this hunk" folds the agent's change into it so it stops showing as a diff. */
export function setOriginalContent(fsPath: string, content: string): void {
  originals.set(fsPath, content);
  changed?.fire(fsPath);
}

function ensureProviderRegistered(context: vscode.ExtensionContext): void {
  if (registered) return;
  registered = true;
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      provideTextDocumentContent: (uri) => originals.get(uri.fsPath) ?? '',
    })
  );
}

/**
 * Open a review diff for an agent-changed file. Falls back to plainly opening
 * the file when no original is recorded (e.g. webview reloaded mid-session).
 */
export async function openAgentDiff(
  context: vscode.ExtensionContext,
  absPath: string
): Promise<void> {
  const fileUri = vscode.Uri.file(absPath);
  if (!originals.has(absPath)) {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }
  ensureProviderRegistered(context);
  const originalUri = fileUri.with({ scheme: SCHEME });
  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    fileUri,
    `${path.basename(absPath)} (WorkspaceGPT changes)`
  );
}
