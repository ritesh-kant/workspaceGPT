// ../../apps/vscode-extensions/src/utils/queryClassifier.ts
var ADO_KEYWORDS = [
  "ticket",
  "tickets",
  "bug",
  "bugs",
  "story",
  "stories",
  "work item",
  "work items",
  "sprint",
  "iteration",
  "backlog",
  "epic",
  "task",
  "tasks",
  "assigned",
  "assignee",
  "ado",
  "azure devops",
  "jira",
  "board",
  "release",
  "milestone",
  "acceptance criteria",
  "status",
  "priority",
  "closed",
  "resolved",
  "in progress",
  "open",
  "blocked",
  "done",
  "triage"
];
var CONFLUENCE_KEYWORDS = [
  "wiki",
  "doc",
  "docs",
  "document",
  "documentation",
  "guide",
  "guides",
  "runbook",
  "runbooks",
  "page",
  "pages",
  "how to",
  "howto",
  "process",
  "architecture",
  "design",
  "playbook",
  "knowledge base",
  "confluence",
  "tutorial",
  "overview",
  "spec",
  "specification",
  "readme",
  "onboarding",
  "setup",
  "install",
  "deploy",
  "deployment",
  "release notes",
  "changelog"
];
var CODEBASE_KEYWORDS = [
  "function",
  "class",
  "method",
  "variable",
  "implementation",
  "implement",
  "repo",
  "repository",
  "codebase",
  "source code",
  "file",
  "files",
  "where is",
  "defined",
  "definition",
  "how does",
  "code",
  "refactor",
  "bug in",
  "import",
  "export",
  "component",
  "module",
  "interface",
  "type",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".json"
];
var INTENT_PATTERNS = [
  {
    intent: "chitchat",
    pattern: /^(hi|hello|hey|thanks|thank you|bye|good morning|good afternoon|good evening|how are you|what's up|yo|sup)\b/i
  },
  {
    // Specific ticket/work-item ID lookups — high confidence routing to ADO
    intent: "lookup",
    pattern: /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/
  },
  {
    intent: "aggregation",
    pattern: /\b(list all|count|how many|show (me )?all|all (open|closed|blocked|done|active|pending)?\s?(tickets?|bugs?|issues?|stories|work items?|tasks?|epics?)|summarize all)\b/i
  },
  {
    intent: "comparison",
    pattern: /\bvs\.?\b|\bversus\b|\bcompare\b|\bdifference between\b|\bcontrast\b/i
  },
  {
    intent: "semantic",
    pattern: /^(how|what|why|when|explain|describe|tell me|help me|what is|what are|walk me through|give me|find)/i
  }
];
function detectIntent(query) {
  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(query)) {
      return { intent, confidence: "high" };
    }
  }
  return { intent: "semantic", confidence: "low" };
}
function detectSources(intent, query, availableSources) {
  if (intent === "chitchat") {
    return { sources: [], confidence: "high" };
  }
  if (intent === "lookup" && /\b\d{5,}\b|\b[A-Z]{2,10}-\d+\b/.test(query)) {
    const adoAvailable = availableSources.includes("ADO");
    return {
      sources: adoAvailable ? ["ADO"] : availableSources.filter((s) => s !== "CODEBASE"),
      confidence: adoAvailable ? "high" : "low"
    };
  }
  const lower = query.toLowerCase();
  const hasCodebaseKeyword = CODEBASE_KEYWORDS.some((kw) => lower.includes(kw));
  if (hasCodebaseKeyword && availableSources.includes("CODEBASE")) {
    return { sources: ["CODEBASE"], confidence: "high" };
  }
  const hasAdoKeyword = ADO_KEYWORDS.some((kw) => lower.includes(kw));
  const hasConfluenceKeyword = CONFLUENCE_KEYWORDS.some((kw) => lower.includes(kw));
  const nonCodebaseSources = availableSources.filter((s) => s !== "CODEBASE");
  if (hasAdoKeyword && !hasConfluenceKeyword) {
    const sources = nonCodebaseSources.filter((s) => s === "ADO");
    return { sources: sources.length ? sources : nonCodebaseSources, confidence: sources.length ? "high" : "low" };
  }
  if (hasConfluenceKeyword && !hasAdoKeyword) {
    const sources = nonCodebaseSources.filter((s) => s === "CONFLUENCE");
    return { sources: sources.length ? sources : nonCodebaseSources, confidence: sources.length ? "high" : "low" };
  }
  if (hasAdoKeyword && hasConfluenceKeyword) {
    return { sources: nonCodebaseSources, confidence: "high" };
  }
  return { sources: nonCodebaseSources, confidence: "low" };
}
function classifyQuery(query, availableSources) {
  const { intent, confidence: intentConfidence } = detectIntent(query);
  const { sources, confidence: sourceConfidence } = detectSources(intent, query, availableSources);
  const confidence = intentConfidence === "high" && sourceConfidence === "high" ? "high" : "low";
  return { intent, sources, confidence };
}
export {
  classifyQuery
};
