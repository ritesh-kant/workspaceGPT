/**
 * Does the report say this USED TO WORK?
 *
 * A bug that worked before has a commit that broke it, and git history can name
 * it: that is a better root-cause lead than reading code. This detects the cue
 * in the user's message and the ticket's own words, and ONLY ADDS: Debug mode
 * gets a "find the introducing commit" paragraph and the report is checked for
 * it. It never gates a tool or a budget (the git tools are always offered in
 * Debug mode), so a missed phrase costs a hint, never a capability.
 */
const REGRESSION_CUE_RE = new RegExp(
  [
    String.raw`\b(was|were|is|are|had been|has been)\s+(working|fine|ok|okay)\s+(before|earlier|previously|until|yesterday|last)`,
    String.raw`\b(used to|did)\s+(work|load|render|save|pass|succeed|run)\b`,
    String.raw`\bworked\s+(fine|before|earlier|previously|until|yesterday|last|in\s+(v?\d|the\s+last))`,
    String.raw`\b(stopped|ceased)\s+working\b`,
    String.raw`\bno longer\s+(work|load|render|save|show|run|pass|happen)`,
    String.raw`\b(broke|broken|breaks|started\s+(failing|breaking|crashing|erroring))\s+(after|since|with|in|when|on)\b`,
    String.raw`\b(broke|broken|failing|wrong)\s+since\b`,
    // "a regression test" is a kind of test, not a report that something broke.
    String.raw`\bregress(ed|ion)\b(?!\s+(tests?|testing|suites?|specs?|checks?|coverage|guards?))`,
    String.raw`\b(after|since)\s+((the|this|last|a|our|latest|recent)\s+){0,3}(release|deploy(ment)?|merge|upgrade|update|refactor|migration|commit|pr|pull request|v?\d+\.\d+)`,
    String.raw`\bworks?\s+(on|in)\s+(v?\d[\w.]*|the\s+(old|previous|last)\s+\w+|production|prod)\s*(but|,)`,
    String.raw`\b(last|previous)\s+(working|good)\s+(version|build|release|commit)`,
  ].join('|'),
  'i'
);

export function hasRegressionCue(...texts: Array<string | undefined | null>): boolean {
  return texts.some((t) => !!t && REGRESSION_CUE_RE.test(t));
}

/** The pieces of a ticket whose wording can carry the cue. */
export function ticketTexts(t?: { title?: string; description?: string; reproSteps?: string; comments?: { text: string }[] } | null): string[] {
  if (!t) return [];
  return [t.title, t.description, t.reproSteps, ...(t.comments ?? []).map((c) => c.text)].filter((x): x is string => !!x);
}
