/**
 * Browser port of the VS Code extension's retrieval pipeline
 * (queryClassifier + queryPlanner + reranker). Keeping the same rules here is
 * what makes Chrome answers match VS Code: greetings skip retrieval, weak
 * matches are filtered out by a per-intent score threshold, and a BM25 + cosine
 * blend reranks what's left. Without this, "hi" pulls in the nearest random
 * chunk and the model parrots whatever it says (including injected text).
 */
import { SearchHit, SourceName } from '@workspace-gpt/embedding-core';

export type QueryIntent = 'chitchat' | 'lookup' | 'aggregation' | 'comparison' | 'semantic';

export interface QueryClassification {
  intent: QueryIntent;
  sources: SourceName[];
  confidence: 'high' | 'low';
}

export interface RetrievalPlan {
  intent: QueryIntent;
  sources: SourceName[];
  topKPerPass: number;
  finalTopK: number;
  maxPasses: number;
  passThreshold: number;
  similarityThreshold: number;
}

// ── Thresholds (mirror vscode constants.ts RETRIEVAL_THRESHOLDS) ─────────
export const RETRIEVAL_THRESHOLDS = {
  LOOKUP_MIN_SCORE: 0.2,
  AGGREGATION_MIN_SCORE: 0.2,
  SEMANTIC_MIN_SCORE: 0.3,
  COMPARISON_MIN_SCORE: 0.3,
  SEMANTIC_PASS2_TRIGGER: 0.45,
  COSINE_WEIGHT: 0.65,
  BM25_WEIGHT: 0.35,
};

// ── Classifier ──────────────────────────────────────────────────────────

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

const INTENT_PATTERNS: Array<{ intent: QueryIntent; pattern: RegExp }> = [
  { intent: 'chitchat', pattern: /^(hi|hello|hey|thanks|thank you|bye|good morning|good afternoon|good evening|how are you|what's up|yo|sup)\b/i },
  { intent: 'lookup', pattern: /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/ },
  { intent: 'aggregation', pattern: /\b(list all|count|how many|show (me )?all|all (open|closed|blocked|done|active|pending)?\s?(tickets?|bugs?|issues?|stories|work items?|tasks?|epics?)|summarize all)\b/i },
  { intent: 'comparison', pattern: /\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference between\b|\bcontrast\b/i },
  { intent: 'semantic', pattern: /^(how|what|why|when|explain|describe|tell me|help me|what is|what are|walk me through|give me|find)/i },
];

function detectIntent(query: string): { intent: QueryIntent; confidence: 'high' | 'low' } {
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(query)) return { intent, confidence: 'high' };
  }
  return { intent: 'semantic', confidence: 'low' };
}

function detectSources(
  intent: QueryIntent,
  query: string,
  available: SourceName[],
): { sources: SourceName[]; confidence: 'high' | 'low' } {
  if (intent === 'chitchat') return { sources: [], confidence: 'high' };

  if (intent === 'lookup' && /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/.test(query)) {
    const adoAvailable = available.includes('ADO');
    return { sources: adoAvailable ? ['ADO'] : available, confidence: adoAvailable ? 'high' : 'low' };
  }

  const lower = query.toLowerCase();
  const hasAdo = ADO_KEYWORDS.some((kw) => lower.includes(kw));
  const hasConfluence = CONFLUENCE_KEYWORDS.some((kw) => lower.includes(kw));

  if (hasAdo && !hasConfluence) {
    const sources = available.filter((s) => s === 'ADO');
    return { sources: sources.length ? sources : available, confidence: sources.length ? 'high' : 'low' };
  }
  if (hasConfluence && !hasAdo) {
    const sources = available.filter((s) => s === 'CONFLUENCE');
    return { sources: sources.length ? sources : available, confidence: sources.length ? 'high' : 'low' };
  }
  if (hasAdo && hasConfluence) return { sources: available, confidence: 'high' };

  return { sources: available, confidence: 'low' };
}

export function classifyQuery(query: string, available: SourceName[]): QueryClassification {
  const { intent, confidence: ic } = detectIntent(query);
  const { sources, confidence: sc } = detectSources(intent, query, available);
  return { intent, sources, confidence: ic === 'high' && sc === 'high' ? 'high' : 'low' };
}

// ── Planner ─────────────────────────────────────────────────────────────

const PLAN_BY_INTENT: Record<QueryIntent, Omit<RetrievalPlan, 'sources' | 'intent'>> = {
  chitchat: { topKPerPass: 0, finalTopK: 0, maxPasses: 1, passThreshold: 0, similarityThreshold: 0 },
  lookup: { topKPerPass: 20, finalTopK: 5, maxPasses: 1, passThreshold: 0, similarityThreshold: RETRIEVAL_THRESHOLDS.LOOKUP_MIN_SCORE },
  aggregation: { topKPerPass: 25, finalTopK: 15, maxPasses: 1, passThreshold: 0, similarityThreshold: RETRIEVAL_THRESHOLDS.AGGREGATION_MIN_SCORE },
  semantic: { topKPerPass: 20, finalTopK: 10, maxPasses: 2, passThreshold: RETRIEVAL_THRESHOLDS.SEMANTIC_PASS2_TRIGGER, similarityThreshold: RETRIEVAL_THRESHOLDS.SEMANTIC_MIN_SCORE },
  comparison: { topKPerPass: 20, finalTopK: 8, maxPasses: 1, passThreshold: 0, similarityThreshold: RETRIEVAL_THRESHOLDS.COMPARISON_MIN_SCORE },
};

export function buildPlan(c: QueryClassification): RetrievalPlan {
  return { ...PLAN_BY_INTENT[c.intent], sources: c.sources, intent: c.intent };
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'about', 'what', 'how', 'why', 'when',
  'where', 'who', 'which', 'that', 'this', 'it', 'its', 'me', 'my', 'i',
  'we', 'our', 'you', 'your', 'they', 'their',
]);

/** Enriches a query for pass 2 with key terms (IDs + proper nouns) from pass-1 hits. */
export function expandQuery(originalQuery: string, pass1: SearchHit[]): string {
  const keyTerms: string[] = [];
  const top = [...pass1].sort((a, b) => b.score - a.score).slice(0, 3);
  for (const r of top) {
    keyTerms.push(...(r.data.fileName.match(/\d{4,}/g) || []));
    const properNouns = r.text
      .split(/\s+/)
      .filter((tok) => {
        const clean = tok.replace(/[^a-zA-Z]/g, '');
        return clean.length >= 3 && /^[A-Z]/.test(clean) && !STOPWORDS.has(clean.toLowerCase());
      })
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
      .filter(Boolean);
    keyTerms.push(...properNouns);
  }
  const lower = originalQuery.toLowerCase();
  const unique = [...new Set(keyTerms)].filter((t) => !lower.includes(t.toLowerCase())).slice(0, 5);
  return unique.length ? `${originalQuery} ${unique.join(' ')}` : originalQuery;
}

// ── Reranker ────────────────────────────────────────────────────────────

function dedupeByFileName(results: SearchHit[]): SearchHit[] {
  const best = new Map<string, SearchHit>();
  for (const r of results) {
    const existing = best.get(r.data.fileName);
    if (!existing || r.score > existing.score) best.set(r.data.fileName, r);
  }
  return [...best.values()];
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/\W+/).filter((t) => t.length >= 2))];
}

/** Proportion of unique query terms present in the text (0–1). */
export function computeBm25Score(query: string, text: string): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t)).length / terms.length;
}

/**
 * Reranks with a BM25 + cosine blend, drops anything below the plan's similarity
 * threshold, and caps at finalTopK. An empty result here means "no relevant
 * context" — the caller must then tell the model so, not pass junk.
 */
export function rerank(query: string, results: SearchHit[], plan: RetrievalPlan): SearchHit[] {
  if (results.length === 0 || plan.finalTopK === 0) return [];

  const scored = dedupeByFileName(results).map((r) => ({
    ...r,
    score:
      r.score * RETRIEVAL_THRESHOLDS.COSINE_WEIGHT +
      computeBm25Score(query, r.text) * RETRIEVAL_THRESHOLDS.BM25_WEIGHT,
  }));

  const filtered =
    plan.similarityThreshold > 0
      ? scored.filter((r) => r.score >= plan.similarityThreshold)
      : scored;

  return filtered.sort((a, b) => b.score - a.score).slice(0, plan.finalTopK);
}
