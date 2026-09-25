/**
 * What bounds a run: the CONTEXT WINDOW, not a turn count.
 *
 * A turn cap is a proxy for cost that correlates badly with it — one turn is a
 * 200-token narration, the next a 40,000-token file read, and the run that
 * needs its 34th turn is exactly the one doing real work. Capping turns ended
 * useful runs early (ADO #1534774) while doing nothing about the runs that
 * actually cost money.
 *
 * The real, physical limit is how much the model can be shown at once. So that
 * is what the loop watches instead — a bound that means something, and one the
 * user can see (the composer's context meter).
 *
 * NOTE: automatic summarizing compaction — which would let a run continue past
 * a full context the way Claude Code does — is deliberately NOT built yet (see
 * docs/todo.md). Until it is, a full context genuinely ends a run. That is still a
 * far later and far more honest stop than the turn cap it replaced.
 *
 * The number it watches is measured, not guessed: every completion response
 * carries `usage.prompt_tokens`, which is the provider's own count of what the
 * conversation cost. Only the window SIZE is an assumption, and it
 * self-corrects (see {@link observedWindowFloor}).
 */

import { REMOTE_MODEL } from '../../../constants';

/**
 * Assumed window when the model is unknown. 128k is the common floor among
 * current hosted models; assuming less would compact needlessly, assuming more
 * would let a prompt grow until the provider rejects it.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * The most context this harness will ever manage, whatever the model allows.
 *
 * The target model (glm-5.3-flash) has a 1,000,000-token window, but filling
 * it is not the goal — answer quality degrades long before a context that size
 * is full, and every turn re-sends the whole conversation, so the last 800k
 * would be paid for on every subsequent round. Ritesh's call, 2026-09-05: cap
 * it at 200k for quality. This is a deliberate ceiling, not an estimate, so it
 * also bounds the self-correction in {@link observedWindowFloor}.
 */
export const MAX_MANAGED_WINDOW = 200_000;

/**
 * Context windows for model families we can name confidently. Matched on the
 * model ID — a machine identifier we receive, not user prose — and a miss
 * costs nothing but the conservative default, so this list never needs to be
 * exhaustive or kept perfectly current.
 */
const KNOWN_CONTEXT_WINDOWS: ReadonlyArray<{ match: RegExp; tokens: number }> = [
  { match: /\bclaude\b/i, tokens: 200_000 },
  { match: /\bgpt-4o|gpt-4\.1|o[34]-(mini|preview)|\bgpt-5/i, tokens: 128_000 },
  { match: /\bgemini-(1\.5|2|2\.5|3)/i, tokens: 1_000_000 },
  // In managed (remote) mode the worker is handed REMOTE_MODEL.ID — a
  // placeholder, not the name of the model actually serving the request — so
  // none of the entries here matched and every managed run silently ran on the
  // 128k default. That is not a guess we need to make: managed inference is
  // ours, we know it is glm behind the placeholder, and the ceiling below is a
  // deliberate choice rather than an estimate. Keep this above the glm entry so
  // it reads as the same decision, once for each name the model arrives under.
  { match: new RegExp(`\\b${REMOTE_MODEL.ID}\\b`, 'i'), tokens: MAX_MANAGED_WINDOW },
  // glm-5.3-flash's real window is 1M; managed at MAX_MANAGED_WINDOW by choice.
  { match: /\bglm\b/i, tokens: MAX_MANAGED_WINDOW },
  { match: /\bminimax\b/i, tokens: 192_000 },
  { match: /\bdeepseek\b/i, tokens: 128_000 },
  // Locally served small models are usually configured far smaller than their
  // nominal maximum (Ollama defaults to 2k-8k unless num_ctx is raised), so
  // this is deliberately pessimistic — compacting early on a local run is much
  // cheaper than overflowing it.
  { match: /\bqwen|llama|mistral|mixtral|gemma|phi-?[0-9]|codestral\b/i, tokens: 32_000 },
];

/**
 * Best available window size, most trustworthy source first:
 *   1. an explicit override (the user knows their deployment),
 *   2. a value the provider reported for this model,
 *   3. the table above,
 *   4. the conservative default.
 */
export function resolveContextWindow(opts: {
  modelId?: string | null;
  reported?: number | null;
  override?: number | null;
}): number {
  if (isUsableWindow(opts.override)) return clampToManaged(opts.override as number);
  if (isUsableWindow(opts.reported)) return clampToManaged(opts.reported as number);
  const id = String(opts.modelId ?? '');
  if (id) {
    for (const entry of KNOWN_CONTEXT_WINDOWS) {
      if (entry.match.test(id)) return clampToManaged(entry.tokens);
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** No run manages more than {@link MAX_MANAGED_WINDOW}, however big the model is. */
function clampToManaged(tokens: number): number {
  return Math.min(tokens, MAX_MANAGED_WINDOW);
}

function isUsableWindow(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 8_000;
}

/**
 * A prompt the provider ACCEPTED is proof the window is at least that big, so
 * an assumption smaller than an observed prompt is simply wrong and is raised
 * to fit. Costs nothing, and stops a pessimistic guess from compacting a run
 * that had plenty of room.
 *
 * Headroom is added because the observation is a lower bound, not the limit:
 * the run was still going, so more was available.
 */
export function observedWindowFloor(assumed: number, observedPromptTokens: number): number {
  if (!Number.isFinite(observedPromptTokens) || observedPromptTokens <= 0) return assumed;
  if (observedPromptTokens < assumed) return assumed;
  // Never past the deliberate quality ceiling — that one is a choice, and an
  // observation must not talk the harness out of it.
  return clampToManaged(Math.ceil((observedPromptTokens * 1.25) / 1_000) * 1_000);
}

/**
 * The share of the window past which the run is in its endgame: room is
 * running out, so it should stop opening new lines of enquiry. Today this
 * drives the meter's warning tone and (via `exhausted`) the convergence
 * narrowing; when compaction lands it becomes the trigger to summarize.
 */
export const COMPACT_AT_PCT = 0.75;

/**
 * Below this much free space there is not room for another meaningful tool
 * result, so the run must conclude with what it has.
 */
export const EXHAUSTED_BELOW_PCT = 0.06;

export interface ContextState {
  /** Provider-reported prompt tokens on the most recent turn. */
  usedTokens: number;
  /** Window size in force (assumed or known). */
  windowTokens: number;
  /** 0-100, for display. */
  usedPct: number;
  /** 0-100, what Claude Code shows as "context left". */
  remainingPct: number;
  /** In the endgame: room is running short (see COMPACT_AT_PCT). */
  shouldCompact: boolean;
  /** No room left for another meaningful tool result — conclude now. */
  exhausted: boolean;
}

export function contextState(input: { promptTokens: number; windowTokens: number }): ContextState {
  const windowTokens = isUsableWindow(input.windowTokens)
    ? input.windowTokens
    : DEFAULT_CONTEXT_WINDOW;
  const usedTokens = Math.max(0, Math.round(input.promptTokens || 0));
  const ratio = usedTokens / windowTokens;
  const usedPct = Math.min(100, Math.round(ratio * 100));
  return {
    usedTokens,
    windowTokens,
    usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
    shouldCompact: ratio >= COMPACT_AT_PCT,
    exhausted: 1 - ratio <= EXHAUSTED_BELOW_PCT,
  };
}

/**
 * Is the run still learning anything?
 *
 * With no turn cap, a model re-reading the same files would loop until the
 * wall clock. This is the fact-based backstop: a turn "advanced" the run if it
 * read a file it had not read, got a tool result it had not seen, or wrote
 * something. {@link STAGNANT_TURNS} consecutive turns without any of that means
 * more turns will not help, and the run is pushed to conclude.
 *
 * Deliberately counts NEW INFORMATION rather than tool calls: a model happily
 * issues the same search forever, and that is precisely the loop to catch.
 */
export const STAGNANT_TURNS = 4;

export function isStagnant(turnsWithoutProgress: number): boolean {
  return turnsWithoutProgress >= STAGNANT_TURNS;
}
