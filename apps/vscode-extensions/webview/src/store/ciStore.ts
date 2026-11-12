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
  pr?: { number: number; url: string; branch: string; sha: string; base?: string };
  checks: CiCheck[];
  /** Unresolved review comments on the PR. */
  comments?: { by: string; body: string; path?: string; line?: number; url?: string }[];
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
  /** Review comments a fix was already tried for (they stay unresolved until a person resolves them, so auto-fix must not redo them). */
  handledComments: string[];
  /** The chat a running fix belongs to; a switch away abandons the push. */
  fixSessionId: string | null;
  setSnapshot: (s: CiSnapshot | null) => void;
  setAutoFix: (on: boolean) => void;
  setPhase: (phase: CiFixPhase, fixSessionId?: string | null) => void;
  setNote: (note: string | null) => void;
  spendAttempt: (pr: number, sha: string, commentKeys?: string[]) => void;
}

export const useCiStore = create<CiStoreState>((set) => ({
  snapshot: null,
  autoFix: readAutoFix(),
  phase: 'idle',
  note: null,
  attempts: {},
  handledSha: null,
  handledComments: [],
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
  spendAttempt: (pr, sha, commentKeys = []) => set((s) => ({ handledSha: sha, handledComments: [...s.handledComments, ...commentKeys], attempts: { ...s.attempts, [pr]: (s.attempts[pr] ?? 0) + 1 } })),
}));

/** Stable identity of a review comment, for "already tried this one". */
export const commentKey = (c: { url?: string; by: string; body: string }): string => c.url ?? `${c.by}:${c.body}`;

/**
 * What the host needs to treat a fix run as a pull-request run: the base to
 * diff against and where each comment points (see workers/model/prReview.ts).
 */
export interface PrReviewMeta {
  base?: string;
  comments: { path: string; line?: number; by?: string }[];
}
export const prReviewMeta = (pr: { base?: string }, comments: NonNullable<CiSnapshot['comments']> = []): PrReviewMeta => ({
  base: pr.base,
  comments: comments.flatMap((c) => (c.path ? [{ path: c.path, line: c.line, by: c.by }] : [])),
});

/**
 * The prompt that starts a fix run: the failing log and/or the PR's unresolved
 * review comments. The push is the app's job, not the model's.
 */
export const ciFixPrompt = (
  pr: { number: number; branch: string; base?: string },
  log?: string,
  comments: NonNullable<CiSnapshot['comments']> = []
): string => {
  const parts: string[] = [];
  if (log) {
    parts.push(
      `CI failed on pull request #${pr.number} (branch ${pr.branch}). Find the cause in the log below and fix it with the smallest change that makes the failing checks pass. ` +
        'Reproduce the failing check locally if you can.\n\n```\n' + log + '\n```'
    );
  }
  if (comments.length) {
    parts.push(
      `Pull request #${pr.number} (branch ${pr.branch}) has unresolved review comments. For each one, read the code it points at and decide whether it is a real problem. ` +
        'Fix the ones that are, with the smallest change. If a comment is mistaken or only a matter of taste, leave the code alone and say why in your final report. ' +
        'Do not reply to or resolve the threads. ' +
        // #1588522: lockfile churn already committed on the branch was judged
        // "not present" because the plain git_diff shows only uncommitted work.
        `The comments are about changes already committed on this branch, so check each against \`git_diff\` with \`base\` ${pr.base ? `"origin/${pr.base}"` : 'set to the branch the PR merges into (e.g. "origin/main")'}, not the uncommitted diff, and confirm a fix the same way. ` +
        'To undo unwanted changes to a generated file such as a lockfile, restore it from that base first and regenerate it there; re-running the generator on top of the current file keeps what is already in it.\n\n' +
        comments.map((c, i) => `${i + 1}. ${c.by}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}${c.url ? ` (${c.url})` : ''}\n${c.body}`).join('\n\n')
    );
  }
  parts.push("Do not commit or push: the app pushes your changes to this PR's branch when you finish.");
  return parts.join('\n\n');
};
