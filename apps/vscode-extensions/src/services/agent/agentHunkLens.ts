import * as vscode from 'vscode';
import { getOriginalContent, hasOriginal, onOriginalsChanged, setOriginalContent } from './agentDiffProvider';

/**
 * Inline hunk review for agent-changed files — the Cursor-style
 * "keep / revert this change" affordance, drawn as CodeLenses above every
 * hunk between the file's pre-agent content and its current text. Keep
 * folds the hunk into the recorded original (so it stops being a change);
 * revert writes the original lines back. A header lens offers keep-all /
 * revert-all for the file.
 */

export interface Hunk {
  /** Original line range [start, end). */
  origStart: number;
  origEnd: number;
  /** Current line range [start, end). */
  curStart: number;
  curEnd: number;
}

const splitLines = (s: string): string[] => (s === '' ? [] : s.split('\n'));

/**
 * Line-level diff → hunks. Common prefix/suffix are trimmed first, then an
 * LCS over the middle; middles too large for a quadratic table fall back to a
 * single hunk covering the whole differing region (still correct, just coarse).
 */
export function computeHunks(original: string, current: string): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(current);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return [];
  if (am.length * bm.length > 4_000_000) {
    return [{ origStart: pre, origEnd: a.length - suf, curStart: pre, curEnd: b.length - suf }];
  }
  // LCS table over the middle.
  const n = am.length;
  const m = bm.length;
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let open: Hunk | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      close();
      i++;
      j++;
      continue;
    }
    if (!open) open = { origStart: pre + i, origEnd: pre + i, curStart: pre + j, curEnd: pre + j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      j++;
      open.curEnd = pre + j;
    } else {
      i++;
      open.origEnd = pre + i;
    }
  }
  close();
  return hunks;
}

function replaceLines(lines: string[], start: number, end: number, replacement: string[]): string[] {
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
}

class AgentHunkLensProvider implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const fsPath = document.uri.fsPath;
    if (document.uri.scheme !== 'file' || !hasOriginal(fsPath)) return [];
    const original = getOriginalContent(fsPath) ?? '';
    const hunks = computeHunks(original, document.getText());
    if (!hunks.length) return [];
    const lenses: vscode.CodeLens[] = [];
    const headerLine = Math.max(0, Math.min(hunks[0].curStart, document.lineCount - 1));
    const headerRange = new vscode.Range(headerLine, 0, headerLine, 0);
    lenses.push(
      new vscode.CodeLens(headerRange, {
        title: `WorkspaceGPT: ${hunks.length} change${hunks.length === 1 ? '' : 's'} in this file`,
        command: '',
      }),
      new vscode.CodeLens(headerRange, { title: '$(check-all) Keep all', command: 'workspacegpt.agent.keepAllHunks', arguments: [document.uri] }),
      new vscode.CodeLens(headerRange, { title: '$(discard) Revert all', command: 'workspacegpt.agent.revertAllHunks', arguments: [document.uri] })
    );
    hunks.forEach((h, idx) => {
      const line = Math.min(h.curStart, Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const added = h.curEnd - h.curStart;
      const removed = h.origEnd - h.origStart;
      lenses.push(
        new vscode.CodeLens(range, { title: `$(check) Keep (+${added} −${removed})`, command: 'workspacegpt.agent.keepHunk', arguments: [document.uri, idx] }),
        new vscode.CodeLens(range, { title: '$(discard) Revert', command: 'workspacegpt.agent.revertHunk', arguments: [document.uri, idx] })
      );
    });
    return lenses;
  }
}

async function currentHunks(uri: vscode.Uri): Promise<{ doc: vscode.TextDocument; hunks: Hunk[]; original: string } | null> {
  const original = getOriginalContent(uri.fsPath);
  if (original == null) return null;
  const doc = await vscode.workspace.openTextDocument(uri);
  return { doc, hunks: computeHunks(original, doc.getText()), original };
}

async function replaceDocument(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
  edit.replace(doc.uri, full, text);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

export function registerAgentHunkLenses(context: vscode.ExtensionContext): void {
  const provider = new AgentHunkLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, provider),
    onOriginalsChanged(() => provider.refresh()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (hasOriginal(e.document.uri.fsPath)) provider.refresh();
    }),
    vscode.commands.registerCommand('workspacegpt.agent.keepHunk', async (uri: vscode.Uri, idx: number) => {
      const state = await currentHunks(uri);
      const h = state?.hunks[idx];
      if (!state || !h) return;
      const curLines = splitLines(state.doc.getText());
      const origLines = splitLines(state.original);
      const next = replaceLines(origLines, h.origStart, h.origEnd, curLines.slice(h.curStart, h.curEnd));
      setOriginalContent(uri.fsPath, next.join('\n'));
    }),
    vscode.commands.registerCommand('workspacegpt.agent.revertHunk', async (uri: vscode.Uri, idx: number) => {
      const state = await currentHunks(uri);
      const h = state?.hunks[idx];
      if (!state || !h) return;
      const curLines = splitLines(state.doc.getText());
      const origLines = splitLines(state.original);
      const next = replaceLines(curLines, h.curStart, h.curEnd, origLines.slice(h.origStart, h.origEnd));
      await replaceDocument(state.doc, next.join('\n'));
    }),
    vscode.commands.registerCommand('workspacegpt.agent.keepAllHunks', async (uri: vscode.Uri) => {
      const doc = await vscode.workspace.openTextDocument(uri);
      setOriginalContent(uri.fsPath, doc.getText());
    }),
    vscode.commands.registerCommand('workspacegpt.agent.revertAllHunks', async (uri: vscode.Uri) => {
      const state = await currentHunks(uri);
      if (!state) return;
      await replaceDocument(state.doc, state.original);
    })
  );
}
