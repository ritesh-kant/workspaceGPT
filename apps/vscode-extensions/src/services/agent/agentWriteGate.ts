/** The minimum a gated action must describe about itself. */
interface GatedAction {
  kind: string;
  summary: string;
}

/**
 * Human-in-the-loop gate between a prepared agent write and its application.
 *
 * The model worker's tool loop blocks awaiting `tool_response`
 * (modelWorker.requestTool), so pausing for approval needs no worker changes:
 * chatService prepares the write, posts a review card to the webview, parks
 * the promise here, and only answers the worker once the user decides.
 *
 * Decisions are per-write (P1 minimal permission model: read=auto,
 * write=review-required). Session-level auto-approve arrives with the full
 * permission model in Phase 2.
 */

export interface WriteDecision {
  approved: boolean;
  /** Optional user note on rejection — fed back to the model so it can adapt. */
  feedback?: string;
  /** 'session' = also remember this approval for the rest of the session (commands only). */
  scope?: 'once' | 'session';
}

interface PendingEntry {
  write: GatedAction;
  resolve: (d: WriteDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

export class AgentWriteGate {
  private pending = new Map<string, PendingEntry>();
  private seq = 0;

  /** Park a prepared action until the webview reports the user's decision. */
  await(write: GatedAction): { id: string; decision: Promise<WriteDecision> } {
    const id = `write-${++this.seq}-${Date.now()}`;
    const decision = new Promise<WriteDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ approved: false, feedback: 'Approval timed out with no user decision.' });
      }, DECISION_TIMEOUT_MS);
      this.pending.set(id, { write, resolve, timer });
    });
    return { id, decision };
  }

  /** Called from the webview's AGENT_WRITE_DECISION message. */
  resolve(id: string, approved: boolean, feedback?: string, scope?: 'once' | 'session'): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve({ approved, feedback, scope });
    return true;
  }

  /** Reject everything outstanding — used when the run is stopped or the chat is reset. */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ approved: false, feedback: reason });
      this.pending.delete(id);
    }
  }
}

// ── Compact diff for the review card ──

export interface ReviewDiff {
  added: number;
  removed: number;
  /** Unified-style text (" ", "-", "+" line prefixes), truncated for transport. */
  text: string;
}

const MAX_DIFF_CHARS = 6_000;
const CONTEXT = 2;

/**
 * Minimal line diff via common prefix/suffix — agent edits are localized
 * single regions (edit_file replaces one contiguous span), so full LCS is
 * unnecessary; creates/deletes are whole-file by definition.
 */
export function buildReviewDiff(before: string, after: string): ReviewDiff {
  const a = before.split('\n');
  const b = after.split('\n');

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const removed = endA - start;
  const added = endB - start;
  const lines: string[] = [];
  for (let i = Math.max(0, start - CONTEXT); i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i < endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i < endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA; i < Math.min(a.length, endA + CONTEXT); i++) lines.push(` ${a[i]}`);

  let text = lines.join('\n');
  if (text.length > MAX_DIFF_CHARS) {
    text = text.slice(0, MAX_DIFF_CHARS) + `\n… (diff truncated — ${removed} removed / ${added} added lines total)`;
  }
  return { added, removed, text };
}
