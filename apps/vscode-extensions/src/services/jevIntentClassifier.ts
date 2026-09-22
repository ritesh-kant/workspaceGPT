import { DataSource, QueryIntent } from '../types/types';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = '~typesafe/jev-latest';

const VALID_INTENTS: QueryIntent[] = ['lookup', 'semantic', 'aggregation', 'comparison', 'chitchat'];

const INTENT_CRITERIA: Record<QueryIntent, string> = {
  lookup: 'asking about a specific ticket, ID, or named item',
  semantic: 'open-ended question, explanation, or how-to',
  aggregation: 'asking to list, count, or summarize multiple items',
  comparison: 'comparing two or more things',
  chitchat: 'greeting or small talk',
};

const SOURCE_CRITERIA: Record<DataSource, string> = {
  CONFLUENCE: "the team's Confluence wiki (documentation, guides, processes)",
  ADO: 'Azure DevOps (tickets, work items, sprints, bugs)',
  JIRA: 'Jira (issues, tickets, sprints, bugs)',
  CODEBASE:
    'the source code repository currently open in the editor (files, components, features, implementation details)',
};

/**
 * Pulls a usable answer out of one question's result, tolerating several
 * plausible response shapes. Jev's Decisions API is alpha and its per-answer
 * field names aren't fully documented, so this degrades to "unresolvable"
 * (null) rather than guessing — the caller falls back to the full-model
 * classifier on null, same as any other failure.
 */
function extractChoice(answer: unknown, validKeys: readonly string[]): string | string[] | null {
  if (typeof answer === 'string') return answer;
  if (Array.isArray(answer) && answer.every((v) => typeof v === 'string')) return answer as string[];
  if (!answer || typeof answer !== 'object') return null;

  const obj = answer as Record<string, unknown>;
  for (const key of ['value', 'answer', 'selected', 'choice', 'choices', 'result']) {
    const v = obj[key];
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  }

  // A probability/confidence map keyed by criteria name (e.g. {lookup: 0.8,
  // semantic: 0.1, ...}) — pick the highest-scoring known key.
  const scored = validKeys
    .filter((k) => typeof obj[k] === 'number')
    .sort((a, b) => (obj[b] as number) - (obj[a] as number));
  return scored.length ? scored[0] : null;
}

export interface JevClassifyResult {
  intent: QueryIntent;
  sources?: DataSource[];
}

/**
 * Classifies a query's intent (and, when several sources are connected,
 * which to consult) via TypeSafe's Jev structured-decision model through
 * OpenRouter's Decisions endpoint, instead of spending a full chat
 * completion on a 5-way pick. Only reachable with a real OpenRouter key —
 * callers should gate on that (see chatService.classifyIntent) and treat any
 * rejection here as "fall back to the existing full-model classifier",
 * never as a reason to skip classification entirely.
 */
export async function classifyIntentWithJev(
  query: string,
  availableSources: DataSource[],
  apiKey: string
): Promise<JevClassifyResult> {
  const questions: Record<string, unknown> = {
    intent: {
      type: 'choice',
      instructions: 'Which single intent best describes this query? Pick exactly one.',
      criteria: INTENT_CRITERIA,
    },
  };
  if (availableSources.length > 1) {
    questions.sources = {
      type: 'choice',
      instructions:
        'Which of these sources should be consulted to answer this query? Pick the single best one unless several are clearly needed.',
      criteria: Object.fromEntries(availableSources.map((s) => [s, SOURCE_CRITERIA[s]])),
    };
  }

  const response = await fetch(DECISIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: JEV_MODEL,
      state: `Query: "${query}"`,
      questions,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Jev classification failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const parsed = (await response.json()) as { answers?: Record<string, unknown> };
  const answers = parsed.answers;
  if (!answers) throw new Error('Jev response had no answers');

  const rawIntent = extractChoice(answers.intent, VALID_INTENTS);
  const intentCandidate = Array.isArray(rawIntent) ? rawIntent[0] : rawIntent;
  if (!intentCandidate || !VALID_INTENTS.includes(intentCandidate as QueryIntent)) {
    throw new Error(`Jev returned an unresolvable intent: ${JSON.stringify(rawIntent)}`);
  }

  let sources: DataSource[] | undefined;
  if (answers.sources) {
    const rawSources = extractChoice(answers.sources, availableSources);
    const candidates = Array.isArray(rawSources) ? rawSources : rawSources ? [rawSources] : [];
    const valid = candidates.filter((s): s is DataSource => availableSources.includes(s as DataSource));
    sources = valid.length ? valid : undefined;
  }

  return { intent: intentCandidate as QueryIntent, sources };
}
