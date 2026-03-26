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

  // Numeric/ticket ID lookups are always ADO
  if (intent === 'lookup' && /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/.test(query)) {
    const adoAvailable = availableSources.includes('ADO');
    return {
      sources: adoAvailable ? ['ADO'] : availableSources,
      confidence: adoAvailable ? 'high' : 'low',
    };
  }

  const lower = query.toLowerCase();

  const hasAdoKeyword = ADO_KEYWORDS.some((kw) => lower.includes(kw));
  const hasConfluenceKeyword = CONFLUENCE_KEYWORDS.some((kw) => lower.includes(kw));

  if (hasAdoKeyword && !hasConfluenceKeyword) {
    const sources = availableSources.filter((s): s is DataSource => s === 'ADO');
    return { sources: sources.length ? sources : availableSources, confidence: sources.length ? 'high' : 'low' };
  }

  if (hasConfluenceKeyword && !hasAdoKeyword) {
    const sources = availableSources.filter((s): s is DataSource => s === 'CONFLUENCE');
    return { sources: sources.length ? sources : availableSources, confidence: sources.length ? 'high' : 'low' };
  }

  if (hasAdoKeyword && hasConfluenceKeyword) {
    return { sources: availableSources, confidence: 'high' };
  }

  // No keyword match — search all available sources, signal low confidence
  return { sources: availableSources, confidence: 'low' };
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
