// ../../apps/vscode-extensions/src/workers/model/explorationPhase.ts
import OpenAI from "/Users/ritesh/codebase/ritesh-codebase/workspaceGPT/node_modules/.pnpm/openai@4.85.4_ws@8.20.1_zod@3.25.76/node_modules/openai/index.js";

// ../../apps/vscode-extensions/src/utils/apiKeyFailover.ts
var stickyStart = /* @__PURE__ */ new Map();
function listKey(list) {
  return list.join("\0");
}
function isRateLimitError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 429)
    return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("429") || msg.includes("too many requests") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}
async function withKeyFailover(keys, fn, onRotate) {
  const candidates = keys.map((k) => (k ?? "").trim()).filter((k) => k.length > 0);
  const list = candidates.length > 0 ? candidates : [""];
  const cacheKey = listKey(list);
  const start = Math.min(stickyStart.get(cacheKey) ?? 0, list.length - 1);
  let lastErr;
  for (let i = start; i < list.length; i++) {
    try {
      const result = await fn(list[i], i);
      stickyStart.set(cacheKey, i);
      return result;
    } catch (err) {
      lastErr = err;
      const canRotate = isRateLimitError(err) && i < list.length - 1;
      if (!canRotate)
        throw err;
      const message = `API key #${i + 1} rate-limited (429) \u2014 failing over to key #${i + 2} of ${list.length}.`;
      console.warn(`[workspaceGPT] ${message}`);
      onRotate?.(message);
      stickyStart.set(cacheKey, i + 1);
    }
  }
  throw lastErr;
}

// ../../apps/vscode-extensions/src/workers/model/jsonExtract.ts
function extractBalancedJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc)
        esc = false;
      else if (ch === "\\")
        esc = true;
      else if (ch === '"')
        inStr = false;
      continue;
    }
    if (ch === '"')
      inStr = true;
    else if (ch === "{") {
      if (depth === 0)
        start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0 && --depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

// ../../apps/vscode-extensions/src/workers/model/explorationPhase.ts
function defaultExplorationConfig(isLocalProvider) {
  return {
    gateMinFiles: 6,
    maxExplorers: isLocalProvider ? 3 : 6,
    explorerInputChars: isLocalProvider ? 16e3 : 48e3,
    explorerMaxTokens: 600,
    claimTableMaxChars: 4e3,
    explorePhaseTimeoutMs: 6e4,
    noiseTermMaxFiles: 200
  };
}
var EMPTY_RESULT = {
  claimTableMarkdown: "",
  stats: { explorers: 0, filesPacked: 0, claimsKept: 0, claimsDropped: 0, charsIn: 0, charsOut: 0, apiCalls: 0, promptTokens: 0, completionTokens: 0 }
};
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "with",
  "from",
  "into",
  "onto",
  "about",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "does",
  "do",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "and",
  "or",
  "but",
  "not",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "as",
  "it",
  "its",
  "if",
  "then",
  "than",
  "so",
  "just",
  "also",
  "like",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "me",
  "my",
  "your",
  "our",
  "code",
  "codebase",
  "file",
  "files",
  "function",
  "please",
  "want",
  "need",
  // Continuation/approval vocabulary. A reply like "continue" or "go ahead"
  // has no topic of its own, but every one of these words appears in ordinary
  // source ("continue;", "proceed()") — so scouting on them matches a large
  // slice of the workspace and passes the spread gate below on pure noise.
  // Observed: a bare "continue" after a failed run scouted the whole monorepo
  // and spent six explorer completions on files chosen for containing that word.
  "continue",
  "proceed",
  "ahead",
  "okay",
  "yeah",
  "sure",
  "yes",
  "keep",
  "going",
  "done",
  "thanks",
  "again",
  "that",
  "this",
  "them",
  "those",
  "good",
  // Task-scaffolding vocabulary. Seeded ticket prompts ("Work on ticket 1234
  // (…) — read the ticket, find the code it affects, propose a plan…") are
  // mostly made of these words, and each one that survives extraction takes a
  // slot from the ticket's actual subject nouns. Observed live: "Work",
  // "ticket", "read" and "find" were scouted while "variant" — the word the
  // ticket was ABOUT — fell off the end of the term cap.
  "work",
  "working",
  "ticket",
  "tickets",
  "read",
  "find",
  "affects",
  "affect",
  "propose",
  "proposed",
  "plan",
  "plans",
  "changing",
  "change",
  "changes",
  "anything",
  "implement",
  "implementing",
  "show",
  "shows",
  "diffs",
  "diff",
  "guessing",
  "unclear",
  "ambiguous",
  "instead",
  "behind",
  "design"
]);
var MAX_SCOUT_TERMS = 16;
function extractSearchTerms(prompt) {
  const identifiers = /* @__PURE__ */ new Set();
  const words = /* @__PURE__ */ new Set();
  const add = (set, t) => {
    const s = t.trim();
    if (s.length >= 3 && !/^\d+$/.test(s))
      set.add(s);
  };
  for (const m of prompt.matchAll(/\b[A-Za-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g))
    add(identifiers, m[0]);
  for (const m of prompt.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi))
    add(identifiers, m[0]);
  for (const m of prompt.matchAll(/\b[\w-]+\.[\w.-]{1,10}\b/g))
    add(identifiers, m[0]);
  for (const m of prompt.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g))
    add(identifiers, m[1] ?? m[2] ?? "");
  for (const w of prompt.split(/[^A-Za-z0-9_]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w.toLowerCase()))
      add(words, w);
  }
  const plainWords = [...words].filter((w) => !identifiers.has(w)).sort((a, b) => b.length - a.length);
  return [...identifiers, ...plainWords].slice(0, MAX_SCOUT_TERMS);
}
function looksLikeIdentifier(term) {
  return /[A-Z_]/.test(term) || term.includes(".");
}
function termWeight(fileCount, noiseCeiling = 200) {
  if (fileCount <= 0 || fileCount > noiseCeiling)
    return 0;
  if (fileCount <= 3)
    return 3;
  if (fileCount <= 15)
    return 2;
  if (fileCount <= 60)
    return 1;
  return 0.25;
}
async function scout(prompt, deps, noiseCeiling = 200) {
  const terms = extractSearchTerms(prompt);
  const textHits = /* @__PURE__ */ new Map();
  const symbolHits = /* @__PURE__ */ new Map();
  await Promise.all(
    terms.map(async (term) => {
      try {
        const r = await deps.requestTool("search_codebase", {
          query: term,
          outputMode: "files_with_matches"
        });
        textHits.set(term, (r?.files ?? []).filter(Boolean));
      } catch {
      }
      if (looksLikeIdentifier(term)) {
        try {
          const r = await deps.requestTool("find_symbol", { query: term });
          symbolHits.set(term, (r?.symbols ?? []).map((sym) => sym.file).filter(Boolean));
        } catch {
        }
      }
    })
  );
  const nameHits = /* @__PURE__ */ new Map();
  const misses = terms.filter((t) => !(textHits.get(t)?.length || symbolHits.get(t)?.length)).slice(0, 5);
  await Promise.all(
    misses.map(async (term) => {
      try {
        const r = await deps.requestTool("find_files", { pattern: `**/*${term}*` });
        nameHits.set(term, (r?.files ?? []).filter(Boolean));
      } catch {
      }
    })
  );
  const hitCounts = /* @__PURE__ */ new Map();
  const bump = (file, weight) => {
    if (!file || weight <= 0)
      return;
    hitCounts.set(file, (hitCounts.get(file) ?? 0) + weight);
  };
  for (const files of textHits.values()) {
    const weight = termWeight(files.length, noiseCeiling);
    for (const f of files)
      bump(f, weight);
  }
  for (const files of symbolHits.values()) {
    if (!files.length || files.length > noiseCeiling)
      continue;
    const weight = 2 * Math.max(termWeight(files.length, noiseCeiling), 0.5);
    for (const f of files)
      bump(f, weight);
  }
  for (const files of nameHits.values()) {
    if (!files.length || files.length > noiseCeiling)
      continue;
    const weight = Math.max(termWeight(files.length, noiseCeiling), 0.5);
    for (const f of files)
      bump(f, weight);
  }
  return hitCounts;
}
function clusterKeyFor(file) {
  const dirSegs = file.split("/").slice(0, -1);
  if (dirSegs.length === 0)
    return "(root)";
  return dirSegs.slice(0, Math.min(3, dirSegs.length)).join("/");
}
function buildClusters(hitCounts, maxExplorers) {
  const byKey = /* @__PURE__ */ new Map();
  for (const [file, hits] of hitCounts) {
    const key = clusterKeyFor(file);
    const c = byKey.get(key) ?? { key, files: [], hits: 0 };
    c.files.push(file);
    c.hits += hits;
    byKey.set(key, c);
  }
  const clusters = [];
  const other = { key: "(other)", files: [], hits: 0 };
  for (const c of byKey.values()) {
    if (c.files.length >= 2)
      clusters.push(c);
    else {
      other.files.push(...c.files);
      other.hits += c.hits;
    }
  }
  if (other.files.length)
    clusters.push(other);
  for (const c of clusters) {
    c.files.sort((a, b) => (hitCounts.get(b) ?? 0) - (hitCounts.get(a) ?? 0));
  }
  clusters.sort((a, b) => b.hits - a.hits);
  return {
    clusters: clusters.slice(0, maxExplorers),
    overflowFiles: clusters.slice(maxExplorers).flatMap((c) => c.files)
  };
}
function shouldExplore(hitCounts, clusters, cfg) {
  if (hitCounts.size < cfg.gateMinFiles)
    return false;
  if (clusters.length < 2)
    return false;
  return true;
}
var EXPLORER_SYSTEM_PREAMBLE = `You are a code-reading assistant. You are shown file contents from ONE part of a codebase and a question about the whole codebase. Report only facts you can see directly in the files below \u2014 never guess, and never describe files you were not shown.

Respond with ONLY a single JSON object, no prose before or after, in exactly this shape:
{"claims":[{"fact":"...","file":"path/from/above","lines":"12-40"}],"entryPoints":[{"symbol":"...","file":"path","line":12}],"unknowns":["..."]}

Rules:
- Every claim's "file" must be one of the files shown below, copied exactly.
- "lines" must be a real line range inside that file's shown content.
- If nothing here answers the question, return empty arrays \u2014 do not invent claims.
- Keep each fact under 200 characters.`;
async function buildPack(files, budgetChars, deps) {
  let text = "";
  const packedLines = /* @__PURE__ */ new Map();
  const skipped = [];
  for (const file of files) {
    if (text.length >= budgetChars) {
      skipped.push(file);
      continue;
    }
    try {
      const r = await deps.requestTool("read_file", { path: file });
      const content = String(r?.content ?? "");
      const totalLines = Number(r?.totalLines) || content.split("\n").length;
      const block = `=== ${file} (lines 1-${totalLines}) ===
${content}

`;
      if (text.length + block.length > budgetChars) {
        skipped.push(file);
        continue;
      }
      text += block;
      packedLines.set(file, totalLines);
    } catch {
      skipped.push(file);
    }
  }
  return { text, packedLines, skipped };
}
function parseExplorerOutput(raw) {
  for (const candidate of extractBalancedJsonObjects(raw)) {
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj?.claims)) {
        return {
          claims: obj.claims.filter(
            (c) => typeof c?.fact === "string" && typeof c?.file === "string"
          ),
          entryPoints: Array.isArray(obj.entryPoints) ? obj.entryPoints : [],
          unknowns: Array.isArray(obj.unknowns) ? obj.unknowns.filter((u) => typeof u === "string") : []
        };
      }
    } catch {
    }
  }
  const note = raw.trim().slice(0, 800);
  return note ? { claims: [{ fact: note, file: "" }], entryPoints: [], unknowns: [] } : { claims: [], entryPoints: [], unknowns: [] };
}
function validateClaims(output, packedLines) {
  const kept = [];
  let dropped = 0;
  for (const c of output.claims) {
    if (!c.file) {
      kept.push(c);
      continue;
    }
    const totalLines = packedLines.get(c.file);
    if (totalLines === void 0) {
      dropped++;
      continue;
    }
    if (c.lines) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(c.lines.trim());
      if (m) {
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        if (a < 1 || b > totalLines || a > b) {
          dropped++;
          continue;
        }
      }
    }
    kept.push(c);
  }
  return { kept, dropped };
}
var EMPTY_EXPLORER_USAGE = { apiCalls: 0, promptTokens: 0, completionTokens: 0 };
async function runOneExplorer(cluster, userPrompt, model, baseURL, apiKeys, cfg, deps) {
  deps.onProgress?.(`Exploring ${cluster.key}\u2026`);
  const { text: pack, packedLines, skipped } = await buildPack(cluster.files, cfg.explorerInputChars, deps);
  if (!pack.trim()) {
    return { cluster, kept: [], entryPoints: [], unknowns: [], skipped: cluster.files, dropped: 0, charsIn: 0, charsOut: 0, ...EMPTY_EXPLORER_USAGE };
  }
  const userContent = `Question: ${userPrompt}

Cluster: ${cluster.key}

` + (skipped.length ? `(not included below \u2014 over budget: ${skipped.join(", ")})

` : "") + pack;
  let raw = "";
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    const response = await withKeyFailover(
      apiKeys,
      (apiKey) => {
        const openai = new OpenAI({ apiKey, baseURL });
        return openai.chat.completions.create({
          model,
          messages: [
            { role: "system", content: EXPLORER_SYSTEM_PREAMBLE },
            { role: "user", content: userContent }
          ],
          temperature: 0,
          max_tokens: cfg.explorerMaxTokens,
          stream: false,
          ...cfg.extraBody ?? {}
        });
      },
      deps.notifyRotate
    );
    raw = response?.choices?.[0]?.message?.content ?? "";
    const rawUsage = response?.usage;
    promptTokens = rawUsage?.prompt_tokens ?? 0;
    completionTokens = rawUsage?.completion_tokens ?? 0;
  } catch {
    return { cluster, kept: [], entryPoints: [], unknowns: [], skipped: cluster.files, dropped: 0, charsIn: userContent.length, charsOut: 0, apiCalls: 1, promptTokens: 0, completionTokens: 0 };
  }
  const output = parseExplorerOutput(raw);
  const { kept, dropped } = validateClaims(output, packedLines);
  return {
    cluster,
    kept,
    entryPoints: output.entryPoints,
    unknowns: output.unknowns,
    skipped,
    dropped,
    charsIn: userContent.length,
    charsOut: raw.length,
    apiCalls: 1,
    promptTokens,
    completionTokens
  };
}
function renderClaimTable(perCluster, overflowFiles, maxChars) {
  const seen = /* @__PURE__ */ new Set();
  let out = "";
  for (const r of perCluster) {
    if (!r.kept.length && !r.entryPoints.length && !r.unknowns.length)
      continue;
    let section = `### ${r.cluster.key}
`;
    for (const c of r.kept) {
      const dedupeKey = `${c.file}:${c.lines ?? ""}:${c.fact.slice(0, 60)}`;
      if (seen.has(dedupeKey))
        continue;
      seen.add(dedupeKey);
      section += c.file ? `- ${c.fact} (${c.file}${c.lines ? `:${c.lines}` : ""})
` : `- ${c.fact} [uncited note]
`;
    }
    for (const e of r.entryPoints)
      section += `- entry point: \`${e.symbol}\` (${e.file}:${e.line})
`;
    for (const u of r.unknowns)
      section += `- unknown: ${u}
`;
    if (r.skipped.length)
      section += `- not explored here (over budget): ${r.skipped.join(", ")}
`;
    if (out.length + section.length > maxChars)
      break;
    out += section;
  }
  if (overflowFiles.length) {
    const line = `
Also matched, unexplored: ${overflowFiles.join(", ")}
`;
    if (out.length + line.length <= maxChars)
      out += line;
  }
  return out.trim();
}
async function runExplorationPhase(userPrompt, model, baseURL, apiKeys, deps, cfg, isLocalProvider, groundingText) {
  try {
    const scoutSource = groundingText ? `${userPrompt}
${groundingText}` : userPrompt;
    if (extractSearchTerms(scoutSource).length === 0)
      return EMPTY_RESULT;
    try {
      const inventory = await deps.requestTool("find_files", { pattern: "**/*" });
      const fileCount = inventory?.totalMatches ?? inventory?.files?.length;
      if (typeof fileCount === "number" && fileCount < cfg.gateMinFiles)
        return EMPTY_RESULT;
    } catch {
    }
    const hitCounts = await scout(scoutSource, deps, cfg.noiseTermMaxFiles);
    const { clusters, overflowFiles } = buildClusters(hitCounts, cfg.maxExplorers);
    if (!shouldExplore(hitCounts, clusters, cfg))
      return EMPTY_RESULT;
    const explorerQuestion = groundingText ? `${userPrompt}

Ticket behind this task (from the issue tracker):
${groundingText.slice(0, 1500)}` : userPrompt;
    const runAll = async () => {
      const runOne = (c) => runOneExplorer(c, explorerQuestion, model, baseURL, apiKeys, cfg, deps);
      if (isLocalProvider) {
        const out = [];
        for (const c of clusters)
          out.push(await runOne(c));
        return out;
      }
      return Promise.all(clusters.map(runOne));
    };
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), cfg.explorePhaseTimeoutMs));
    const settled = await Promise.race([runAll().catch(() => null), timeout]) ?? [];
    if (!settled.length)
      return EMPTY_RESULT;
    const claimTableMarkdown = renderClaimTable(settled, overflowFiles, cfg.claimTableMaxChars);
    const stats = settled.reduce(
      (acc, r) => ({
        explorers: acc.explorers + 1,
        filesPacked: acc.filesPacked + (r.cluster.files.length - r.skipped.length),
        claimsKept: acc.claimsKept + r.kept.length,
        claimsDropped: acc.claimsDropped + r.dropped,
        charsIn: acc.charsIn + r.charsIn,
        charsOut: acc.charsOut + r.charsOut,
        apiCalls: acc.apiCalls + r.apiCalls,
        promptTokens: acc.promptTokens + r.promptTokens,
        completionTokens: acc.completionTokens + r.completionTokens
      }),
      { explorers: 0, filesPacked: 0, claimsKept: 0, claimsDropped: 0, charsIn: 0, charsOut: 0, apiCalls: 0, promptTokens: 0, completionTokens: 0 }
    );
    return { claimTableMarkdown, stats };
  } catch {
    return EMPTY_RESULT;
  }
}
export {
  defaultExplorationConfig,
  extractSearchTerms,
  runExplorationPhase,
  scout,
  termWeight
};
