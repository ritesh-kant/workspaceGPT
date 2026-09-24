/**
 * `vscode.diff` for the desktop: the review panel the chat frame draws over
 * the conversation (Phase 2, replacing VS Code's diff editor + hunk lenses).
 *
 * The extension opens a diff in one place: the files-changed bar's "review"
 * (agentDiffProvider.openAgentDiff → vscode.diff(original, current, title)).
 * In VS Code the user then keeps or reverts hunks through CodeLenses that
 * agentHunkLens.ts draws in the right-hand editor. The desktop has no editor,
 * so this panel shows the same hunks — computed by the extension's own
 * computeHunks — with the same Keep / Revert / Keep all / Revert all buttons,
 * and each button runs the command the lens would have run
 * (workspacegpt.agent.keepHunk and friends). The panel only draws; what a
 * keep or revert does stays the extension's code.
 *
 * Both sides are re-read after every action, so the panel always shows what
 * is on disk and in the extension's recorded original.
 */
import * as path from 'node:path';
import * as compat from '../vscode-compat';
import { computeHunks } from 'workspacegpt-extension-hunks';
import type { ViewSurface } from './webviewHost';

/** The scheme agentDiffProvider registers for "the file before the agent's first write". */
const AGENT_ORIGINAL_SCHEME = 'workspacegpt-original';
const CONTEXT_LINES = 3;
/** A whole-file rewrite of a huge file is still one hunk; cap what the page renders. */
const MAX_LINES_PER_SIDE = 2000;

export interface DiffHunkView {
  /** 1-based first line of `before` in the current file (context and added lines count from here). */
  curLine: number;
  /** 1-based first removed line in the original. */
  origLine: number;
  before: string[];
  removed: string[];
  added: string[];
  after: string[];
  truncated: boolean;
}

export interface DiffFrame {
  t: 'diff';
  file: string;
  /** Workspace-relative when inside a folder. */
  label: string;
  title: string;
  /** Keep/revert only exist for agent diffs, which have a recorded original. */
  reviewable: boolean;
  hunks: DiffHunkView[];
  added: number;
  removed: number;
}

export type DiffAction = 'keep' | 'revert' | 'keepAll' | 'revertAll' | 'openInEditor' | 'close';

const HUNK_COMMANDS: Record<'keep' | 'revert' | 'keepAll' | 'revertAll', string> = {
  keep: 'workspacegpt.agent.keepHunk',
  revert: 'workspacegpt.agent.revertHunk',
  keepAll: 'workspacegpt.agent.keepAllHunks',
  revertAll: 'workspacegpt.agent.revertAllHunks',
};

const splitLines = (s: string): string[] => (s === '' ? [] : s.split('\n'));

function cap(lines: string[]): { lines: string[]; truncated: boolean } {
  return lines.length > MAX_LINES_PER_SIDE ? { lines: lines.slice(0, MAX_LINES_PER_SIDE), truncated: true } : { lines, truncated: false };
}

export function createDiffPanel(surface: ViewSurface, workspaceFolders: () => string[]) {
  /** fsPath → the diff the page may act on. The page can only name files opened here. */
  const open = new Map<string, { left: compat.Uri; right: compat.Uri; title: string }>();

  async function render(fsPath: string): Promise<DiffFrame | undefined> {
    const d = open.get(fsPath);
    if (!d) return undefined;
    const [leftDoc, rightDoc] = await Promise.all([compat.workspace.openTextDocument(d.left), compat.workspace.openTextDocument(d.right)]);
    const original = leftDoc.getText();
    const current = rightDoc.getText();
    const hunks = computeHunks(original, current);
    const a = splitLines(original);
    const b = splitLines(current);
    // A file ending in "\n" splits to a last '' that isn't a line anyone wrote; don't show it as context.
    const shownEnd = b.length && b[b.length - 1] === '' ? b.length - 1 : b.length;
    let added = 0;
    let removed = 0;
    const views = hunks.map((h) => {
      added += h.curEnd - h.curStart;
      removed += h.origEnd - h.origStart;
      const beforeStart = Math.max(0, h.curStart - CONTEXT_LINES);
      const rem = cap(a.slice(h.origStart, h.origEnd));
      const add = cap(b.slice(h.curStart, h.curEnd));
      return {
        curLine: beforeStart + 1,
        origLine: h.origStart + 1,
        before: b.slice(beforeStart, h.curStart),
        removed: rem.lines,
        added: add.lines,
        after: b.slice(h.curEnd, Math.min(h.curEnd + CONTEXT_LINES, shownEnd)),
        truncated: rem.truncated || add.truncated,
      };
    });
    const root = workspaceFolders().find((r) => fsPath === r || fsPath.startsWith(r + path.sep));
    return {
      t: 'diff',
      file: fsPath,
      label: root ? path.relative(root, fsPath) : fsPath,
      title: d.title,
      reviewable: d.left.scheme === AGENT_ORIGINAL_SCHEME,
      hunks: views,
      added,
      removed,
    };
  }

  async function push(fsPath: string): Promise<void> {
    const frame = await render(fsPath);
    if (frame) surface.sendControl(frame);
  }

  /** The `vscode.diff` built-in. */
  async function show(left: compat.Uri, right: compat.Uri, title?: string): Promise<void> {
    if (right.scheme !== 'file') throw new Error(`vscode.diff: the right-hand side must be a file (got ${right.scheme}:)`);
    open.set(right.fsPath, { left, right, title: title ?? `${path.basename(right.fsPath)} (changes)` });
    await push(right.fsPath);
  }

  /** A button on the panel. */
  async function act(fsPath: string, action: DiffAction, idx?: number): Promise<void> {
    const d = open.get(fsPath);
    if (!d) {
      console.warn(`[desktop] diff action ${action} for ${fsPath}, which has no open diff — ignored`);
      return;
    }
    if (action === 'close') {
      open.delete(fsPath);
      return;
    }
    if (action === 'openInEditor') {
      await compat.commands.executeCommand('vscode.open', d.right);
      return;
    }
    if (d.left.scheme !== AGENT_ORIGINAL_SCHEME) return;
    const args: unknown[] = [d.right];
    if (action === 'keep' || action === 'revert') {
      if (!Number.isInteger(idx) || idx! < 0) return;
      args.push(idx);
    }
    await compat.commands.executeCommand(HUNK_COMMANDS[action], ...args);
    await push(fsPath);
  }

  return { show, act };
}
