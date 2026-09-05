/**
 * What a finished turn is allowed to SAY about itself.
 *
 * A turn can end with no prose from the model at all: a provider that returned
 * an empty completion, or a tool loop that exited without writing its summary.
 * The webview used to paper over that with one constant sentence — "Done — see
 * the steps above for what was explored and changed" — which is false in three
 * separate ways on a turn that ran no tools and changed nothing: it was not
 * done, there are no steps above, and nothing changed.
 *
 * Observed live on ticket #1534774. A doc-only turn (no codebase tools, so no
 * ability to edit anything) was asked "can you fix it", retrieved nothing
 * useful, returned no text — and the UI reported "Done". The user reasonably
 * believed a fix had been applied. A false completion claim is worse than a
 * failure: it costs the user their trust in every later report, and they only
 * find out by checking the diff themselves.
 *
 * The rule encoded here: never describe work that did not happen. The HOST
 * owns the facts (writes applied, steps posted), so the host decides the
 * wording and the webview renders it, rather than the webview inventing prose
 * about a run it only partly observed.
 */

export interface TurnOutcomeFacts {
  /** The model's own answer text for this turn. Trimmed by the caller or here. */
  answerText: string;
  /** Files this turn actually wrote, per the host's own accounting — never the model's claim. */
  writesApplied: number;
  /** Structured steps posted for this turn (tool calls, reads, notices). */
  stepsPosted: number;
}

export type TurnOutcome =
  /** The model produced prose. Nothing to synthesize; deliver it as-is. */
  | { kind: 'answered' }
  /**
   * No prose, but the turn did observable work. The steps and files-changed
   * rollup must survive, so they need a message to attach to — but its text
   * may only claim what actually happened.
   */
  | { kind: 'silent'; text: string }
  /**
   * No prose and no work. This is a failed turn and has to be reported as
   * one, with a way to retry — never as a completion.
   */
  | { kind: 'empty'; text: string };

/**
 * Decide what a turn may report about itself, from facts only.
 *
 * Pure on purpose: this is the one place that can turn "the model said
 * nothing" into a sentence shown to the user, so it is worth testing
 * exhaustively rather than reasoning about in situ.
 */
export function describeTurnOutcome(facts: TurnOutcomeFacts): TurnOutcome {
  const answerText = String(facts.answerText ?? '').trim();
  if (answerText) return { kind: 'answered' };

  // Guard against a negative or non-finite count reaching the prose.
  const writes = Number.isFinite(facts.writesApplied) ? Math.max(0, Math.trunc(facts.writesApplied)) : 0;
  const steps = Number.isFinite(facts.stepsPosted) ? Math.max(0, Math.trunc(facts.stepsPosted)) : 0;

  if (steps === 0 && writes === 0) {
    return {
      kind: 'empty',
      text:
        'The model returned an empty response — no tools were run and no files were changed. ' +
        'Nothing was done. Try again, or rephrase the request.',
    };
  }

  // Work happened but the model never summarized it. Say exactly what is
  // known, and point at the evidence the user can check themselves.
  if (writes > 0) {
    return {
      kind: 'silent',
      text:
        `The model stopped without writing a summary, but the run did change ` +
        `${writes} file${writes === 1 ? '' : 's'} — review the diffs above before relying on this turn.`,
    };
  }

  return {
    kind: 'silent',
    text:
      'The model stopped without writing a summary. No files were changed — ' +
      'the steps above are everything this turn did.',
  };
}
