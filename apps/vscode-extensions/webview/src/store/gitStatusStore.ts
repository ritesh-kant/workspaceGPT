import { useMemo } from 'react';
import { create } from 'zustand';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { useChatStore, type TurnSummary } from './chatStore';

/** Working-tree snapshot from the host's gitStatusService. */
export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  added: number;
  removed: number;
  filesChanged: number;
  hasRemote: boolean;
  /** `origin`'s PR-by-number URL with `{id}` to substitute — undefined when the host is unknown. */
  prUrlTemplate?: string;
  /** Of the paths the last request named (a chat's recorded files), those still uncommitted, with their diff vs. HEAD. */
  pathStats?: { path: string; added: number; removed: number }[];
}

/**
 * Which Create PR is in flight. A turn ship reports its outcome on the
 * message card that produced it (persisted there by App.tsx), so the status
 * bar only announces the whole-tree ship — the one with no card of its own.
 */
export type ShipScope = 'turn' | 'tree';

export type ShipState =
  | { phase: 'idle' }
  | { phase: 'running'; requestId: string; scope: ShipScope }
  | { phase: 'done'; scope: ShipScope; branch: string; baseBranch?: string; pushed: boolean; prUrl?: string; warnings: string[]; ticketCommented?: boolean; ticketId?: string }
  | { phase: 'error'; scope: ShipScope; error: string };

/** What the composer's Create PR ships when the latest turn is shippable. */
export interface TurnShipInput {
  ticketId?: string;
  ticketType?: string;
  title?: string;
  report: string;
  files: string[];
  hasNewFiles: boolean;
}

interface GitStatusState {
  status: GitStatus | null;
  ship: ShipState;
  /** Diff the user dismissed the bar for; it returns as soon as the tree moves on. */
  dismissedSignature: string | null;
  setStatus: (status: GitStatus) => void;
  setShip: (ship: ShipState) => void;
  dismiss: (signature: string) => void;
  /** Ship the whole working tree (no turn behind it). */
  createPr: () => void;
  /** Ship one agent turn — ticket-aware, and the report becomes the PR body. */
  createPrForTurn: (sessionId: string | null, input: TurnShipInput) => void;
}

/**
 * Git status + "Create PR" state, shared rather than owned by one component:
 * the status bar above the composer renders the branch and diff, while the
 * Create PR button lives down in the composer's control row. Both read this
 * store, so there is exactly one poll loop (useGitStatusSync) and one ship
 * state behind them.
 */
export const useGitStatusStore = create<GitStatusState>((set) => ({
  status: null,
  ship: { phase: 'idle' },
  dismissedSignature: null,
  setStatus: (status) => set({ status }),
  setShip: (ship) => set({ ship }),
  dismiss: (dismissedSignature) => set({ dismissedSignature }),
  createPr: () => {
    const requestId = `ship-all-${Date.now().toString(36)}`;
    set({ ship: { phase: 'running', requestId, scope: 'tree' } });
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.AGENT_SHIP_ALL, requestId });
  },
  createPrForTurn: (sessionId, shipInput) => {
    const requestId = `ship-${Date.now().toString(36)}`;
    set({ ship: { phase: 'running', requestId, scope: 'turn' } });
    // shipInput travels with the message (rather than relying only on the
    // host's in-memory record of the last shippable turn) so this still works
    // after an extension host restart — it all lives on the persisted message.
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.AGENT_SHIP, sessionId, requestId, shipInput });
  },
}));

/** Identity of the current diff — what a dismissal is scoped to. */
export const statusSignature = (s: GitStatus): string =>
  `${s.branch}|${s.added}|${s.removed}|${s.filesChanged}`;

/** True when there is something uncommitted to show or ship. */
export const hasShippableChanges = (s: GitStatus | null): s is GitStatus =>
  !!s && s.isRepo && s.filesChanged > 0;

type FileKind = TurnSummary['filesChanged'][number]['kind'];

/**
 * Files a chat has changed and not yet shipped, by path: every shippable
 * turn's files back to the most recent shipped turn. A ship takes all of the
 * chat's uncommitted recorded files, so nothing before it is still pending.
 */
export const recordedChatFiles = (
  messages: readonly { isUser: boolean; turnSummary?: TurnSummary }[]
): Map<string, FileKind> => {
  const files = new Map<string, FileKind>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const summary = messages[i].turnSummary;
    if (messages[i].isUser || !summary) continue;
    if (summary.shipped) break;
    if (!summary.shippable) continue;
    for (const f of summary.filesChanged) if (!files.has(f.path)) files.set(f.path, f.kind);
  }
  return files;
};

/** The on-screen chat's share of the working tree — what the bar reports and Create PR ships. */
export interface ChatChanges {
  /** This chat's recorded files that are still uncommitted. */
  files: string[];
  added: number;
  removed: number;
  /** Uncommitted files this chat did not record: another chat's, or the user's own. */
  others: number;
}

export const chatChanges = (s: GitStatus | null, recorded: ReadonlyMap<string, FileKind>): ChatChanges => {
  // Filtered by `recorded` again: a reply to a request made for the previous
  // chat can still land after a switch, and must not count as this one's.
  const own = (s?.pathStats ?? []).filter((p) => recorded.has(p.path));
  return {
    files: own.map((p) => p.path),
    added: own.reduce((n, p) => n + p.added, 0),
    removed: own.reduce((n, p) => n + p.removed, 0),
    others: Math.max(0, (s?.filesChanged ?? 0) - own.length),
  };
};

/** The chat on screen's recorded files and its share of the current git status. */
export const useChatChanges = (): { recorded: Map<string, FileKind>; changes: ChatChanges } => {
  const messages = useChatStore((s) => s.messages);
  const status = useGitStatusStore((s) => s.status);
  const recorded = useMemo(() => recordedChatFiles(messages), [messages]);
  return { recorded, changes: useMemo(() => chatChanges(status, recorded), [status, recorded]) };
};
