import { DataSource, QueryClassification, QueryIntent } from 'src/types/types';

// ── Keyword lists ──────────────────────────────────────────────────────

const ADO_KEYWORDS = [
  'ticket', 'tickets', 'bug', 'bugs', 'story', 'stories', 'work item',
  'work items', 'sprint', 'iteration', 'backlog', 'epic', 'task', 'tasks',
  'assigned', 'assignee', 'ado', 'azure devops', 'jira', 'board', 'release',
  'milestone', 'acceptance criteria', 'status', 'priority', 'closed',
  'resolved', 'in progress', 'open', 'blocked', 'done', 'triage',
];

const CONFLUENCE_KEYWORDS = [
  'wiki', 'doc', 'docs', 'document', 'documentation', 'guide', 'guides',
  'runbook', 'runbooks', 'page', 'pages', 'how to', 'howto', 'process',
  'architecture', 'design', 'playbook', 'knowledge base', 'confluence',
  'tutorial', 'overview', 'spec', 'specification', 'readme', 'onboarding',
  'setup', 'install', 'deploy', 'deployment', 'release notes', 'changelog',
];

const CODEBASE_KEYWORDS = [
  'function', 'class', 'method', 'variable', 'implementation', 'implement',
  'repo', 'repository', 'codebase', 'source code', 'file', 'files',
  'where is', 'defined', 'definition', 'how does', 'code', 'refactor',
  'bug in', 'import', 'export', 'component', 'module', 'interface', 'type',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.java', '.rs', '.json',
];

// ── Intent detection ───────────────────────────────────────────────────

const INTENT_PATTERNS: Array<{ intent: QueryIntent; pattern: RegExp }> = [
  {
    intent: 'chitchat',
    pattern: /^(hi|hello|hey|thanks|thank you|bye|good morning|good afternoon|good evening|how are you|what's up|yo|sup)\b/i,
  },
  {
    // Specific ticket/work-item ID lookups — high confidence routing to ADO
    intent: 'lookup',
    pattern: /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/,
  },
  {
    intent: 'aggregation',
    pattern: /\b(list all|count|how many|show (me )?all|all (open|closed|blocked|done|active|pending)?\s?(tickets?|bugs?|issues?|stories|work items?|tasks?|epics?)|summarize all)\b/i,
  },
  {
    intent: 'comparison',
    pattern: /\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference between\b|\bcontrast\b/i,
  },
  {
    intent: 'semantic',
    pattern: /^(how|what|why|when|explain|describe|tell me|help me|what is|what are|walk me through|give me|find)/i,
  },
];

function detectIntent(query: string): { intent: QueryIntent; confidence: 'high' | 'low' } {
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(query)) {
      return { intent, confidence: 'high' };
    }
  }
  // Default to semantic with low confidence — may be upgraded via LLM
  return { intent: 'semantic', confidence: 'low' };
}

// ── Source detection ───────────────────────────────────────────────────

function detectSources(
  intent: QueryIntent,
  query: string,
  availableSources: DataSource[]
): { sources: DataSource[]; confidence: 'high' | 'low' } {
  // Chitchat needs no data sources
  if (intent === 'chitchat') {
    return { sources: [], confidence: 'high' };
  }

  const lower = query.toLowerCase();

  // Numeric/ticket ID lookups default to ADO — but if the query also asks to
  // investigate/implement code (e.g. "find the code it affects, propose a
  // plan"), route to the live tool-calling agent loop instead. That loop's
  // toolset already includes get_ticket, so it fetches the ticket itself
  // before exploring code — a plain ADO-only RAG turn has no tools at all
  // and can only describe a plan, never execute one.
  if (intent === 'lookup' && /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/.test(query)) {
    const hasCodebaseKeyword = CODEBASE_KEYWORDS.some((kw) => lower.includes(kw));
    if (hasCodebaseKeyword && availableSources.includes('CODEBASE')) {
      return { sources: ['CODEBASE'], confidence: 'high' };
    }
    const adoAvailable = availableSources.includes('ADO');
    return {
      sources: adoAvailable ? ['ADO'] : availableSources.filter((s) => s !== 'CODEBASE'),
      confidence: adoAvailable ? 'high' : 'low',
    };
  }

  // Codebase is mutually exclusive with Confluence/ADO for a given turn — if
  // the query looks code-related and codebase tools are available, route
  // there and skip the doc/ticket keyword checks entirely.
  const hasCodebaseKeyword = CODEBASE_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasCodebaseKeyword && availableSources.includes('CODEBASE')) {
    return { sources: ['CODEBASE'], confidence: 'high' };
  }

  const hasAdoKeyword = ADO_KEYWORDS.some((kw) => lower.includes(kw));
  const hasConfluenceKeyword = CONFLUENCE_KEYWORDS.some((kw) => lower.includes(kw));

  // Codebase is opt-in only via an explicit keyword match above — none of the
  // doc/ticket fallback paths below should silently pull it in, since that
  // would let chatService's exclusivity rule hijack every ambiguous query.
  const nonCodebaseSources = availableSources.filter((s) => s !== 'CODEBASE');

  if (hasAdoKeyword && !hasConfluenceKeyword) {
    const sources = nonCodebaseSources.filter((s) => s === 'ADO');
    return { sources: sources.length ? sources : nonCodebaseSources, confidence: sources.length ? 'high' : 'low' };
  }

  if (hasConfluenceKeyword && !hasAdoKeyword) {
    const sources = nonCodebaseSources.filter((s) => s === 'CONFLUENCE');
    return { sources: sources.length ? sources : nonCodebaseSources, confidence: sources.length ? 'high' : 'low' };
  }

  if (hasAdoKeyword && hasConfluenceKeyword) {
    return { sources: nonCodebaseSources, confidence: 'high' };
  }

  // No keyword match — search all available non-codebase sources, signal low confidence
  return { sources: nonCodebaseSources, confidence: 'low' };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Classifies a user query into an intent and target data sources using rule-based heuristics.
 * Returns `confidence: 'low'` when no pattern matched — the caller can then
 * optionally upgrade the intent via an LLM call.
 */
export function classifyQuery(
  query: string,
  availableSources: DataSource[]
): QueryClassification {
  const { intent, confidence: intentConfidence } = detectIntent(query);
  const { sources, confidence: sourceConfidence } = detectSources(intent, query, availableSources);

  const confidence =
    intentConfidence === 'high' && sourceConfidence === 'high' ? 'high' : 'low';

  return { intent, sources, confidence };
}
