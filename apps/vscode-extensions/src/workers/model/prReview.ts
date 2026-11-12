/**
 * A run that addresses a pull request's review comments works on changes that
 * are already COMMITTED on the branch, so the plain uncommitted diff shows
 * none of them. #1588522: a reviewer flagged lockfile churn, the run checked
 * `git_diff` (empty), re-ran the generator over the churned file, and
 * reported "No change needed" — the churn was still in the PR.
 *
 * Two facts fix that class, neither read from the model's wording:
 *  1. The run starts knowing what the PR changes (files vs the PR's base),
 *     and git_diff defaults to that base (host side, chatService).
 *  2. Before the report is accepted, every commented file whose PR diff is
 *     byte-for-byte what it was when the run started is named back to the
 *     model with the hunk the comment points at. A nudge, once: leaving a
 *     comment alone is allowed, calling it fixed or absent is not.
 */

export interface PrReviewContext {
  /** A ref for the branch the PR merges into, e.g. "origin/main". */
  base: string;
  comments: { path: string; line?: number; by?: string }[];
}

export interface PrBaseline {
  /** Files the PR changes, vs base. Empty when git could not say. */
  files: string[];
  /** Per commented path: its PR diff when the run started. */
  diffs: Map<string, string>;
}

/** git_diff through the host; resolves to its output text, or null on failure. */
export type PrDiff = (args: { path?: string; base: string; nameOnly?: boolean }) => Promise<string | null>;

const NO_CHANGES = '(no changes)';
const MAX_FILES_LISTED = 40;
const MAX_HUNK_LINES = 30;

export async function snapshotPrReview(ctx: PrReviewContext, diff: PrDiff): Promise<PrBaseline> {
  const names = await diff({ base: ctx.base, nameOnly: true });
  const files = names && names !== NO_CHANGES ? names.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  const diffs = new Map<string, string>();
  for (const path of new Set(ctx.comments.map((c) => c.path))) {
    const d = await diff({ path, base: ctx.base });
    if (d !== null) diffs.set(path, d);
  }
  return { files, diffs };
}

/** Appended to the run's first message: what "this PR" is, before any tool call. */
export function prReviewContextBlock(ctx: PrReviewContext, baseline: PrBaseline): string {
  if (!baseline.files.length) return '';
  const shown = baseline.files.slice(0, MAX_FILES_LISTED).map((f) => `- ${f}`).join('\n');
  const more = baseline.files.length > MAX_FILES_LISTED ? `\n- … and ${baseline.files.length - MAX_FILES_LISTED} more` : '';
  return (
    `\n\nThis pull request's changes are committed on the branch. Compared with ${ctx.base}, it changes:\n${shown}${more}\n` +
    `In this run \`git_diff\` shows the change since ${ctx.base} (committed and uncommitted) unless you pass \`base: ""\` for uncommitted work only.`
  );
}

/** The hunk of a unified diff whose new-file range covers `line`; else the first lines of the diff. */
export function hunkAt(diffText: string, line?: number): string {
  const lines = diffText.split('\n');
  const starts = lines.flatMap((l, i) => (l.startsWith('@@') ? [i] : []));
  let pick = starts[0] ?? 0;
  if (line) {
    const covering = starts.find((s) => {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(lines[s]);
      return !!m && line >= Number(m[1]) && line < Number(m[1]) + Number(m[2] ?? 1);
    });
    // The reviewer's line can predate later commits. Another hunk shown in its
    // place would read as the comment's target, so list them all instead.
    if (covering === undefined && starts.length) {
      const headers = starts.slice(0, 20).map((s) => lines[s]);
      return `(line ${line} is not inside a changed hunk now; this file's changes are at:)\n${headers.join('\n')}${starts.length > 20 ? '\n…' : ''}`;
    }
    if (covering !== undefined) pick = covering;
  }
  const end = starts.find((s) => s > pick) ?? lines.length;
  const hunk = lines.slice(pick, Math.min(end, pick + MAX_HUNK_LINES));
  return hunk.join('\n') + (end - pick > MAX_HUNK_LINES ? '\n…' : '');
}

export interface UntouchedComment {
  path: string;
  line?: number;
  by?: string;
  hunk: string;
}

/** Comments whose file's PR diff is still exactly what it was when the run began. */
export async function untouchedComments(ctx: PrReviewContext, baseline: PrBaseline, diff: PrDiff): Promise<UntouchedComment[]> {
  const out: UntouchedComment[] = [];
  const now = new Map<string, string | null>();
  for (const c of ctx.comments) {
    const before = baseline.diffs.get(c.path);
    if (before === undefined || before === NO_CHANGES) continue;
    if (!now.has(c.path)) now.set(c.path, await diff({ path: c.path, base: ctx.base }));
    const after = now.get(c.path);
    if (after === before) out.push({ path: c.path, line: c.line, by: c.by, hunk: hunkAt(before, c.line) });
  }
  return out;
}

export function prReviewNudge(ctx: PrReviewContext, list: UntouchedComment[]): string {
  const items = list
    .map((c) => `- ${c.by ? `${c.by} on ` : ''}\`${c.path}${c.line ? `:${c.line}` : ''}\` — still in the PR, unchanged by this run:\n\`\`\`diff\n${c.hunk}\n\`\`\``)
    .join('\n');
  return (
    `Before this is accepted: these review comments point at changes that are still in the pull request exactly as the reviewer saw them (diff against ${ctx.base}, committed and uncommitted):\n` +
    items +
    '\nFor each: if your report calls it fixed, not present or no change needed, that is wrong — fix it now (a generated file such as a lockfile is restored from the base and regenerated), or report it as left alone with the reason. ' +
    'Then give your final answer.'
  );
}
