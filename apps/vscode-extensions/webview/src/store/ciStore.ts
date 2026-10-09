import { create } from 'zustand';

export type CiStateName = 'none' | 'pending' | 'passed' | 'failed' | 'merged' | 'closed' | 'unavailable';

export interface CiCheck {
  name: string;
  state: 'pass' | 'fail' | 'pending';
  url?: string;
}

/** Host snapshot of the PR on the chat's branch (see ciService.ts). */
export interface CiSnapshot {
  state: CiStateName;
  reason?: string;
  pr?: { number: number; url: string; branch: string; sha: string };
  checks: CiCheck[];
  failureLog?: string;
}

/** Where an auto-fix cycle is: the agent is editing, or its edits are being pushed. */
export type CiFixPhase = 'idle' | 'fixing' | 'pushing';

/** A PR gets at most this many fix attempts, so a fix that cannot work does not loop forever. */
export const MAX_CI_FIX_ATTEMPTS = 3;

const AUTOFIX_KEY = 'wgpt.ci.autoFix';

const readAutoFix = (): boolean => {
  try {
    return localStorage.getItem(AUTOFIX_KEY) === '1';
  } catch {
    return false;
  }
};

interface CiStoreState {
  snapshot: CiSnapshot | null;
  autoFix: boolean;
  phase: CiFixPhase;
  /** Last outcome worth showing under the chip ("Pushed a fix", "Push failed: …"). */
  note: string | null;
  /** Fix attempts spent per PR number. */
  attempts: Record<number, number>;
  /** Head commit a fix was already tried for — the same failing commit is never fixed twice. */
  handledSha: string | null;
  /** The chat a running fix belongs to; a switch away abandons the push. */
  fixSessionId: string | null;
  setSnapshot: (s: CiSnapshot | null) => void;
  setAutoFix: (on: boolean) => void;
  setPhase: (phase: CiFixPhase, fixSessionId?: string | null) => void;
  setNote: (note: string | null) => void;
  spendAttempt: (pr: number, sha: string) => void;
}

export const useCiStore = create<CiStoreState>((set) => ({
  snapshot: null,
  autoFix: readAutoFix(),
  phase: 'idle',
  note: null,
  attempts: {},
  handledSha: null,
  fixSessionId: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setAutoFix: (autoFix) => {
    try {
      localStorage.setItem(AUTOFIX_KEY, autoFix ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
    set({ autoFix });
  },
  setPhase: (phase, fixSessionId = null) => set({ phase, fixSessionId }),
  setNote: (note) => set({ note }),
  spendAttempt: (pr, sha) => set((s) => ({ handledSha: sha, attempts: { ...s.attempts, [pr]: (s.attempts[pr] ?? 0) + 1 } })),
}));

/** The prompt that starts a fix run. Carries the failing log; the push is the app's job, not the model's. */
export const ciFixPrompt = (pr: { number: number; branch: string }, log: string): string =>
  `CI failed on pull request #${pr.number} (branch ${pr.branch}). Find the cause in the log below and fix it with the smallest change that makes the failing checks pass. ` +
  `Reproduce the failing check locally if you can. Do not commit or push: the app pushes your changes to this PR's branch when you finish.\n\n` +
  '```\n' +
  log +
  '\n```';
