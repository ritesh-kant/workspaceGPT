import { create } from 'zustand';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';

/** Working-tree snapshot from the host's gitStatusService. */
export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  added: number;
  removed: number;
  filesChanged: number;
  hasRemote: boolean;
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
  | { phase: 'done'; scope: ShipScope; branch: string; prUrl?: string; warnings: string[]; ticketCommented?: boolean; ticketId?: number }
  | { phase: 'error'; scope: ShipScope; error: string };

/** What the composer's Create PR ships when the latest turn is shippable. */
export interface TurnShipInput {
  ticketId?: number;
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
