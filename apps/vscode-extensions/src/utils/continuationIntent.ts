/**
 * What counts as "carry on with what you were doing".
 *
 * These live outside chatService because they are now a CONTRACT between two
 * places: the host parses them, and the webview's Resume button has to produce
 * a message that satisfies them. Keeping the patterns and the word the button
 * sends in one file is what stops those two drifting apart — see
 * {@link RESUME_MESSAGE} for the failure that motivated it.
 */

/**
 * Bare continuation/confirmation replies ("go ahead", "continue", "yes"), which
 * have no topical content of their own. Classifying one in isolation from the
 * ongoing conversation is effectively a coin flip that can silently abandon an
 * in-progress codebase investigation for a generic chat answer (observed live:
 * mid-investigation "go ahead" got reclassified away from CODEBASE).
 */
export const CONTINUATION_RE =
  /^(go ahead|go on|continue|keep going|please continue|please proceed|proceed|do it|yes|yep|yeah|sure|ok|okay|sounds good)[\s.!?]*$/i;

/**
 * Replies that approve a proposal and ask for it to be carried out. Broader
 * than CONTINUATION_RE on purpose — that one only decides *routing* for a bare
 * "go ahead", while this decides whether the turn is an EXECUTION turn. The
 * replies that actually show up here ("fix it", "implement 1-3", "apply it")
 * match none of CONTINUATION_RE's alternatives.
 */
export const APPROVAL_RE =
  /^(?:please\s+)?(?:yes[\s,.!]*)?(?:go ahead|go on|go for it|continue|keep going|proceed|do it|do that|ship it|lgtm|fix(?:\s+(?:it|that|this))?|implement(?:\s+(?:it|that|this|them|all|\d[\d\s,and–—-]*))?|apply(?:\s+(?:it|them|that|the\s+\w+))?|make the (?:change|changes|edit|edits|fix|fixes)|start|begin)[\s.!]*$/i;

/**
 * Replies that ask the agent to pick up a run that was cut short — the words
 * people actually reach for after a provider error, a crash or a stop ("try
 * again", "resume", "finish the test file"). Wider than CONTINUATION_RE (bare
 * confirmations) and APPROVAL_RE (approving a proposal) because it decides only
 * one thing: whether the stranded tool transcript of the interrupted run is
 * worth carrying into this turn. A false positive costs a longer prompt; a
 * false negative throws away every step the previous attempt took.
 */
export const RESUME_RE =
  /^(?:please\s+|now\s+|ok(?:ay)?[\s,]+)?(?:continue|carry on|resume|retry|try again|keep going|pick up|finish|complete)\b[^.!?]{0,60}[\s.!?]*$/i;

/**
 * The message the webview's Resume button sends.
 *
 * A bare "continue" and nothing else, deliberately, because it has to satisfy
 * BOTH patterns at once:
 *
 * - {@link RESUME_RE} decides whether the stranded transcript is carried into
 *   the turn at all.
 * - {@link CONTINUATION_RE} is narrower (bare confirmations only) and decides
 *   that the turn inherits the previous one's routing instead of being
 *   reclassified from scratch.
 *
 * The natural-sounding "Continue the interrupted run." matches the first and
 * FAILS the second, which would route a resume through query classification
 * and, on a reloaded window, away from codebase tools entirely — losing the
 * very transcript the button exists to recover. The invariant is asserted in
 * the headless suite so a later reword cannot quietly break it.
 */
export const RESUME_MESSAGE = 'continue';

/** True when this reply asks to pick up an interrupted run. */
export function isContinuationIntent(message: string): boolean {
  const trimmed = String(message ?? '').trim();
  return RESUME_RE.test(trimmed) || APPROVAL_RE.test(trimmed) || CONTINUATION_RE.test(trimmed);
}
