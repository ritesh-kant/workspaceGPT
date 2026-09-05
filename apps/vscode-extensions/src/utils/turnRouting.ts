import type { DataSource, QueryClassification } from 'src/types/types';

/**
 * The routing decision for one chat turn, as a pure function so it can be
 * pinned by headless tests (packages/agent-evals/src/headless/unit-tests.mjs).
 *
 * ── Capability is a FACT, not a guess ──
 * A workspace folder being open is what makes the tool-calling loop possible,
 * so that alone decides whether a turn runs it. The classifier never touches
 * capability: its sources decide only what is PRE-FETCHED before the model
 * runs (and how — the retrieval plan), never what the model is allowed to do.
 *
 * This replaced a keyword-routed choice between two mutually exclusive paths —
 * "codebase" (tools, no retrieval) and "docs" (retrieval, no tools) — and the
 * mechanisms that grew around it to repair a wrong guess: routing inheritance,
 * the zero-source fallback, the execute-mandate force, the LLM re-route,
 * `lastUseCodebaseTools`, and the continuation/approval/resume patterns feeding
 * them. The failure that ended it (ADO #1534774): "can you fix it", sent after
 * an ADO answer, contained no code keyword, so it ran as a tool-less doc turn
 * and could not edit anything — then reported "Done". Now tools are on whenever
 * they can exist, and a wrong guess about what to pre-fetch costs one
 * round-trip, never an ability.
 */

export interface TurnRoutingInput {
  /** A workspace folder is open. The one fact that grants the tool loop. */
  isCodebaseAvailable: boolean;
  /** Sources that are actually connected (and, for CODEBASE, open). */
  availableSources: DataSource[];
  /** The rule-based classification of the message. */
  classification: QueryClassification;
  /** The context picker's label: 'Auto', 'Confluence', 'Azure DevOps', 'Codebase'. */
  contextSelection: string;
}

export interface TurnRouting {
  /** Whether this turn runs the tool-calling loop. From facts only. */
  useCodebaseTools: boolean;
  /**
   * What to pre-fetch. CODEBASE is never in here — it is not a retrieval
   * source — so an explicit "Codebase" pick means "search no docs".
   */
  classification: QueryClassification;
  /**
   * An explicit picker choice that could not be applied because that source is
   * not available. Routing proceeds as if the picker were on Auto; the caller
   * tells the user. Only ever narrows pre-fetch — never what the model can do.
   */
  unhonoredSource: DataSource | null;
}

/** The picker label → source. Unknown labels map to null (treated as "everything"). */
export function explicitSourceFor(contextSelection: string): DataSource | null {
  switch (contextSelection) {
    case 'Confluence':
      return 'CONFLUENCE';
    case 'Azure DevOps':
      return 'ADO';
    case 'Codebase':
      return 'CODEBASE';
    default:
      return null;
  }
}

export function decideTurnRouting(input: TurnRoutingInput): TurnRouting {
  const { isCodebaseAvailable, availableSources, contextSelection } = input;
  let classification = input.classification;
  let unhonoredSource: DataSource | null = null;

  if (contextSelection !== 'Auto') {
    const explicitSource = explicitSourceFor(contextSelection);
    if (explicitSource && availableSources.includes(explicitSource)) {
      classification = { ...classification, sources: [explicitSource], confidence: 'high' };
    } else if (!explicitSource) {
      classification = { ...classification, sources: availableSources, confidence: 'high' };
    } else {
      unhonoredSource = explicitSource;
    }
  }

  return {
    useCodebaseTools: isCodebaseAvailable,
    classification: {
      ...classification,
      sources: classification.sources.filter((source) => source !== 'CODEBASE'),
    },
    unhonoredSource,
  };
}
