import * as fsp from 'fs/promises';
import * as path from 'path';
import { isTransientServerError, isRateLimitError } from '../../utils/apiKeyFailover';

/**
 * On-disk holding pen for the transcript of an agent run that was cut short.
 *
 * The in-memory half of this already existed: the worker mirrors its
 * model-facing `messages` array up to the host at every round boundary, and
 * `SessionRun.agentTranscript` keeps it so a "continue" reply can resume
 * instead of re-exploring the repo. That covers a provider error, a stall or a
 * user stop — as long as the extension host stays alive.
 *
 * It does not survive a window reload, an extension restart, or reopening the
 * session from history, which is exactly when a user comes back to a run that
 * died overnight. `runs` is a plain Map that starts empty, so the work is
 * simply gone. This module is the missing half: the same transcript, written
 * beside the chat history, so resuming is a property of the SESSION rather
 * than of the current process.
 *
 * Three deliberate constraints:
 *
 * - **Its own directory**, not the `chats/` folder. `HistoryService.getHistoryList`
 *   reads and JSON-parses every `*.json` file in there to build the history
 *   list, so a sibling `<id>.resume.json` would both show up as a phantom
 *   session and put a multi-hundred-KB parse in front of every list render.
 * - **Stale state is discarded, not offered.** A transcript records what files
 *   said at the time; hours later the repo has moved and resuming would have
 *   the model reason about content that no longer exists. Past
 *   {@link MAX_RESUME_AGE_MS} the record is treated as absent.
 * - **Size-capped.** A ticket run's tool budget is 400 KB of results, and all
 *   of it can end up here. Beyond {@link MAX_RESUME_BYTES} the oldest rounds
 *   are dropped rather than the whole record — the recent end of an
 *   investigation is the part worth resuming from.
 */

/** Records older than this are ignored: the repo has moved on underneath them. */
export const MAX_RESUME_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Cap on the serialized record. Generous — the point of resuming is to keep
 * expensive context — but bounded so a runaway session cannot fill the
 * extension's global storage.
 */
export const MAX_RESUME_BYTES = 4 * 1024 * 1024;

export interface ResumeRecord {
  sessionId: string;
  /** Epoch ms of the write, so age can be judged on load and shown to the user. */
  savedAt: number;
  /** Model-facing messages, images already stripped by the host. */
  transcript: unknown[];
  /** Why the run stopped — quoted back when the resume is offered. */
  reason: string;
  /** File changes the interrupted run had already applied to disk. */
  writesApplied?: number;
  /** The work item it was working on, when there was one. */
  ticketId?: string;
}

/** The subset of `fs/promises` this module uses, injectable for tests. */
export interface ResumeFileIO {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  rm(file: string, opts: { force: true }): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  stat(file: string): Promise<{ mtimeMs: number }>;
}

const defaultIO: ResumeFileIO = {
  mkdir: (dir, opts) => fsp.mkdir(dir, opts),
  writeFile: (file, data, encoding) => fsp.writeFile(file, data, encoding),
  readFile: (file, encoding) => fsp.readFile(file, encoding),
  rm: (file, opts) => fsp.rm(file, opts),
  readdir: (dir) => fsp.readdir(dir),
  stat: (file) => fsp.stat(file),
};

/**
 * Session ids come from the webview. Anything that could escape the storage
 * directory is rejected outright rather than sanitized — a mangled id would
 * silently read and write the wrong session's record.
 */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function recordPath(dir: string, sessionId: string): string | null {
  if (!SAFE_ID_RE.test(sessionId) || sessionId === '.' || sessionId === '..') return null;
  return path.join(dir, `${sessionId}.json`);
}

/**
 * Drops whole rounds from the OLD end until the record fits.
 *
 * Rounds, not individual messages: an assistant turn carrying `tool_calls`
 * and the `tool` messages answering them are one indivisible unit — every
 * OpenAI-compatible provider rejects a conversation where a tool result has
 * no matching call, or a call has no result. The worker's own
 * `seedFromTranscript` repairs gaps defensively, but producing them here
 * would be gambling on that.
 */
export function trimTranscriptToFit(transcript: unknown[], maxBytes: number): unknown[] {
  let out = transcript;
  while (out.length && JSON.stringify(out).length > maxBytes) {
    // Find the start of the second round and cut everything before it.
    let cut = 1;
    while (cut < out.length && (out[cut] as { role?: string })?.role === 'tool') cut++;
    // Never let a "trim" fail to shrink the array, or this loops forever.
    out = out.slice(Math.max(1, cut));
  }
  return out;
}

/** Writes the record, replacing any previous one for this session. */
export async function saveResumeRecord(
  dir: string,
  record: ResumeRecord,
  io: ResumeFileIO = defaultIO
): Promise<boolean> {
  const file = recordPath(dir, record.sessionId);
  if (!file || !record.transcript?.length) return false;
  try {
    await io.mkdir(dir, { recursive: true });
    const transcript = trimTranscriptToFit(record.transcript, MAX_RESUME_BYTES);
    if (!transcript.length) return false;
    await io.writeFile(file, JSON.stringify({ ...record, transcript }), 'utf8');
    return true;
  } catch (e) {
    // Losing the ability to resume must never break the run that is producing
    // it. Log and carry on.
    console.warn('[workspaceGPT] could not persist resume state:', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Reads the record for a session, or null when there is nothing usable —
 * absent, unparseable, for a different session, or too old.
 */
export async function loadResumeRecord(
  dir: string,
  sessionId: string,
  now: number = Date.now(),
  io: ResumeFileIO = defaultIO
): Promise<ResumeRecord | null> {
  const file = recordPath(dir, sessionId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await io.readFile(file, 'utf8')) as ResumeRecord;
    if (!Array.isArray(parsed?.transcript) || !parsed.transcript.length) return null;
    if (parsed.sessionId !== sessionId) return null;
    const savedAt = Number(parsed.savedAt);
    if (!Number.isFinite(savedAt) || now - savedAt > MAX_RESUME_AGE_MS) return null;
    return { ...parsed, savedAt };
  } catch {
    // Missing file, truncated write, or a record from an older shape.
    return null;
  }
}

/** Forgets the record. Safe to call when there is none. */
export async function clearResumeRecord(
  dir: string,
  sessionId: string,
  io: ResumeFileIO = defaultIO
): Promise<void> {
  const file = recordPath(dir, sessionId);
  if (!file) return;
  try {
    await io.rm(file, { force: true });
  } catch {
    /* nothing to forget */
  }
}

/**
 * Deletes records past {@link MAX_RESUME_AGE_MS}, so an abandoned run's 400 KB
 * does not sit in global storage forever. Called once on activation, never on
 * the hot path; failures are ignored because this is housekeeping.
 */
export async function pruneResumeRecords(
  dir: string,
  now: number = Date.now(),
  io: ResumeFileIO = defaultIO
): Promise<number> {
  let removed = 0;
  try {
    for (const name of await io.readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const { mtimeMs } = await io.stat(file);
        if (now - mtimeMs > MAX_RESUME_AGE_MS) {
          await io.rm(file, { force: true });
          removed++;
        }
      } catch {
        /* raced with another window — leave it */
      }
    }
  } catch {
    /* directory does not exist yet */
  }
  return removed;
}

/** Human-readable age, for the message that offers the resume. */
export function describeAge(savedAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - savedAt);
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/** The user pressed stop. Never auto-resumed — they asked it to end. */
const CANCELLED_RE = /generation cancelled by user/i;

/** The host's own 5-minute silence net, and a worker that died under us. */
const WORKER_DEATH_RE =
  /(stopped responding|no activity for|worker (?:crashed|exited|stopped|terminated)|premature close|socket hang ?up|econnreset|etimedout|enotfound|fetch failed|network (?:error|timeout))/i;

/**
 * Whether an interrupted run should be picked up AUTOMATICALLY, rather than
 * only offered to the user.
 *
 * The bar is: would a fresh worker on the same transcript plausibly get
 * further? That is true for the provider being overloaded, for a dead socket,
 * and for the stall net firing on a hung turn — in each case the model did
 * nothing wrong and a fresh attempt is the whole fix. It is false for the
 * failures that will reproduce exactly:
 *
 * - **Cancellation.** The user ended it on purpose.
 * - **401/403.** No session, no key; a retry burns another minute to say so
 *   again. The user has to sign in, and the error already tells them that.
 * - **429 with every key exhausted.** A retry needs a wait measured in
 *   minutes, not the seconds an auto-resume would give it. Still offered
 *   manually — by the time the user reads it, the window may have passed.
 * - **4xx generally.** A malformed or oversized request resumes into the same
 *   malformed or oversized request.
 *
 * A false positive costs one wasted run; a false negative costs the user's
 * whole investigation. But an auto-resume that cannot possibly work is worse
 * than either, because it delays the real error behind another full attempt.
 */
export function isAutoResumableFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (!message) return false;
  if (CANCELLED_RE.test(message)) return false;
  if (isRateLimitError(err)) return false;
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  if (/^\s*4\d\d\b/.test(message)) return false;
  return isTransientServerError(err) || WORKER_DEATH_RE.test(message);
}
