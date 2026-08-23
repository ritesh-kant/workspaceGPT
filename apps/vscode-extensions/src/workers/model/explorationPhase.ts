import OpenAI from 'openai';
import { withKeyFailover } from '../../utils/apiKeyFailover';
import { extractBalancedJsonObjects } from './jsonExtract';

/**
 * Exploration decomposition — see EXPLORATION-DECOMPOSITION-DESIGN.md.
 *
 * Runs BEFORE the agentic tool loop for codebase questions that would touch
 * many files across several parts of the repo. Instead of letting the main
 * loop read all of that into `messages` (where it's re-billed every
 * subsequent round until microcompaction kicks in), a deterministic scout
 * finds where the answer likely lives, groups the hits into clusters, and
 * spends model tokens on ONE disposable, tool-less completion per cluster.
 * Each completion is paid once and thrown away; only its cited claims survive
 * into the main loop's context.
 *
 * Decomposition itself (scouting, clustering, merging) is all plain code —
 * never a model call. A weak model mis-plans a split and mis-merges several
 * reports; code does both deterministically and for free.
 *
 * The phase is pure best-effort: any failure (a bad completion, a timeout, an
 * empty scout) degrades to an empty result, and the caller falls through to
 * today's unchanged agent loop. This phase must never make a run worse than
 * the status quo.
 */

// ── Config ──

export interface ExplorationConfig {
  /** Below this many distinct hit files, inline reads in the main loop are cheaper than any explorer. */
  gateMinFiles: number;
  /** Fewer than 2 clusters means one explorer would just repeat the main loop's own reads. */
  maxExplorers: number;
  /** Per-explorer file-content budget, in characters. */
  explorerInputChars: number;
  explorerMaxTokens: number;
  claimTableMaxChars: number;
  explorePhaseTimeoutMs: number;
  /** Extra provider-specific request-body fields (e.g. OpenRouter's reasoning-effort cap). */
  extraBody?: Record<string, unknown>;
}

export function defaultExplorationConfig(isLocalProvider: boolean): ExplorationConfig {
  return {
    gateMinFiles: 6,
    maxExplorers: isLocalProvider ? 3 : 6,
    explorerInputChars: isLocalProvider ? 16_000 : 48_000,
    explorerMaxTokens: 600,
    claimTableMaxChars: 4_000,
    explorePhaseTimeoutMs: 60_000,
  };
}

export interface ExplorationDeps {
  /** Same signature as modelWorker's requestTool — delegates to the main thread's codebase tools. */
  requestTool: (name: string, args: unknown, id?: string) => Promise<unknown>;
  /** Surfaced as a transient status label while an explorer is running. */
  onProgress?: (label: string) => void;
  /** Forwarded to withKeyFailover so key rotation is visible in the UI, same as the main loop. */
  notifyRotate?: (message: string) => void;
}

export interface ExplorationStats {
  explorers: number;
  filesPacked: number;
  claimsKept: number;
  claimsDropped: number;
  charsIn: number;
  charsOut: number;
  apiCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ExplorationResult {
  /** "" means the gate declined or the phase found nothing usable — caller runs the loop unchanged. */
  claimTableMarkdown: string;
  stats: ExplorationStats;
}

const EMPTY_RESULT: ExplorationResult = {
  claimTableMarkdown: '',
  stats: { explorers: 0, filesPacked: 0, claimsKept: 0, claimsDropped: 0, charsIn: 0, charsOut: 0, apiCalls: 0, promptTokens: 0, completionTokens: 0 },
};

// ── 1. Scout — find where the answer likely lives, at zero model cost ──

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'with', 'from', 'into', 'onto', 'about',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'does', 'do', 'did',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'and', 'or', 'but', 'not', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'as',
  'it', 'its', 'if', 'then', 'than', 'so', 'just', 'also', 'like',
  'i', 'you', 'we', 'they', 'he', 'she', 'me', 'my', 'your', 'our',
  'code', 'codebase', 'file', 'files', 'function', 'please', 'want', 'need',
]);

/** Extracts search terms from a user question — deterministic, no model call. */
function extractSearchTerms(prompt: string): string[] {
  const terms = new Set<string>();
  const add = (t: string) => {
    const s = t.trim();
    if (s.length >= 3) terms.add(s);
  };

  // camelCase / PascalCase identifiers (e.g. "LeadsView", "fetchData")
  for (const m of prompt.matchAll(/\b[A-Za-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) add(m[0]);
  // snake_case identifiers
  for (const m of prompt.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi)) add(m[0]);
  // dotted tokens / filenames (api.ts, foo.bar)
  for (const m of prompt.matchAll(/\b[\w-]+\.[\w.-]{1,10}\b/g)) add(m[0]);
  // quoted phrases
  for (const m of prompt.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g)) add((m[1] ?? m[2] ?? ''));
  // remaining informative words
  for (const w of prompt.split(/[^A-Za-z0-9_]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w.toLowerCase())) add(w);
  }

  return [...terms].slice(0, 12);
}

/** A term that looks like an identifier is worth a symbol lookup too, not just text search. */
function looksLikeIdentifier(term: string): boolean {
  return /[A-Z_]/.test(term) || term.includes('.');
}

/** Deterministic, zero-model-token survey of which files are relevant to the question. */
async function scout(prompt: string, deps: ExplorationDeps): Promise<Map<string, number>> {
  const terms = extractSearchTerms(prompt);
  const hitCounts = new Map<string, number>();
  const termHadHit = new Map<string, boolean>(terms.map((t) => [t, false]));
  const bump = (term: string, file: string, weight: number) => {
    if (!file) return;
    hitCounts.set(file, (hitCounts.get(file) ?? 0) + weight);
    termHadHit.set(term, true);
  };

  await Promise.all(
    terms.map(async (term) => {
      try {
        const r = (await deps.requestTool('search_codebase', {
          query: term,
          outputMode: 'files_with_matches',
        })) as { files?: string[] } | null;
        for (const f of r?.files ?? []) bump(term, f, 1);
      } catch {
        // Scouting is best-effort — a failed lookup just yields fewer hits, never an error.
      }
      if (looksLikeIdentifier(term)) {
        try {
          const r = (await deps.requestTool('find_symbol', { query: term })) as
            | { symbols?: { file: string }[] }
            | null;
          for (const s of r?.symbols ?? []) bump(term, s.file, 2); // a symbol hit is a stronger signal than a text match
        } catch {
          // best-effort
        }
      }
    })
  );

  // A term with zero hits so far gets one filename-pattern fallback — a doc
  // can describe a feature in prose that never appears verbatim in the file
  // that implements it. Capped: this is a fallback, not the main search.
  const misses = terms.filter((t) => !termHadHit.get(t)).slice(0, 5);
  await Promise.all(
    misses.map(async (term) => {
      try {
        const r = (await deps.requestTool('find_files', { pattern: `**/*${term}*` })) as
          | { files?: string[] }
          | null;
        for (const f of r?.files ?? []) bump(term, f, 1);
      } catch {
        // best-effort
      }
    })
  );

  return hitCounts;
}

// ── 2/3. Gate + cluster — deterministic, structural ──

interface Cluster {
  key: string;
  files: string[];
  hits: number;
}

/** Groups a file under its package/app root, or its first source-level directory within one. */
function clusterKeyFor(file: string): string {
  const dirSegs = file.split('/').slice(0, -1);
  if (dirSegs.length === 0) return '(root)';
  return dirSegs.slice(0, Math.min(3, dirSegs.length)).join('/');
}

function buildClusters(
  hitCounts: Map<string, number>,
  maxExplorers: number
): { clusters: Cluster[]; overflowFiles: string[] } {
  const byKey = new Map<string, Cluster>();
  for (const [file, hits] of hitCounts) {
    const key = clusterKeyFor(file);
    const c = byKey.get(key) ?? { key, files: [], hits: 0 };
    c.files.push(file);
    c.hits += hits;
    byKey.set(key, c);
  }

  // Clusters too small to justify a dedicated explorer fold into a shared bucket.
  const clusters: Cluster[] = [];
  const other: Cluster = { key: '(other)', files: [], hits: 0 };
  for (const c of byKey.values()) {
    if (c.files.length >= 2) clusters.push(c);
    else {
      other.files.push(...c.files);
      other.hits += c.hits;
    }
  }
  if (other.files.length) clusters.push(other);

  clusters.sort((a, b) => b.hits - a.hits);
  return {
    clusters: clusters.slice(0, maxExplorers),
    overflowFiles: clusters.slice(maxExplorers).flatMap((c) => c.files),
  };
}

function shouldExplore(hitCounts: Map<string, number>, clusters: Cluster[], cfg: ExplorationConfig): boolean {
  if (hitCounts.size < cfg.gateMinFiles) return false; // small spread — inline reads are cheaper
  if (clusters.length < 2) return false; // one cluster = no decomposition benefit
  return true;
}

// ── 4. Explore — one disposable, tool-less completion per cluster ──

const EXPLORER_SYSTEM_PREAMBLE = `You are a code-reading assistant. You are shown file contents from ONE part of a codebase and a question about the whole codebase. Report only facts you can see directly in the files below — never guess, and never describe files you were not shown.

Respond with ONLY a single JSON object, no prose before or after, in exactly this shape:
{"claims":[{"fact":"...","file":"path/from/above","lines":"12-40"}],"entryPoints":[{"symbol":"...","file":"path","line":12}],"unknowns":["..."]}

Rules:
- Every claim's "file" must be one of the files shown below, copied exactly.
- "lines" must be a real line range inside that file's shown content.
- If nothing here answers the question, return empty arrays — do not invent claims.
- Keep each fact under 200 characters.`;

/** Packs whole files (in hit-rank order) into one string, stopping once the budget is spent. */
async function buildPack(
  files: string[],
  budgetChars: number,
  deps: ExplorationDeps
): Promise<{ text: string; packedLines: Map<string, number>; skipped: string[] }> {
  let text = '';
  const packedLines = new Map<string, number>();
  const skipped: string[] = [];

  for (const file of files) {
    if (text.length >= budgetChars) {
      skipped.push(file);
      continue;
    }
    try {
      const r = (await deps.requestTool('read_file', { path: file })) as
        | { content?: string; totalLines?: number }
        | null;
      const content = String(r?.content ?? '');
      const totalLines = Number(r?.totalLines) || content.split('\n').length;
      const block = `=== ${file} (lines 1-${totalLines}) ===\n${content}\n\n`;
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

interface Claim {
  fact: string;
  file: string;
  lines?: string;
}
interface EntryPoint {
  symbol: string;
  file: string;
  line: number;
}
interface ExplorerOutput {
  claims: Claim[];
  entryPoints: EntryPoint[];
  unknowns: string[];
}

/** Parses the explorer's JSON contract, tolerating the same fence/tag noise local models produce elsewhere. */
function parseExplorerOutput(raw: string): ExplorerOutput {
  for (const candidate of extractBalancedJsonObjects(raw)) {
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj?.claims)) {
        return {
          claims: obj.claims.filter(
            (c: unknown): c is Claim =>
              typeof (c as Claim)?.fact === 'string' && typeof (c as Claim)?.file === 'string'
          ),
          entryPoints: Array.isArray(obj.entryPoints) ? obj.entryPoints : [],
          unknowns: Array.isArray(obj.unknowns) ? obj.unknowns.filter((u: unknown) => typeof u === 'string') : [],
        };
      }
    } catch {
      // try the next candidate object
    }
  }
  // No parseable contract — keep a short, explicitly uncited note rather than nothing.
  const note = raw.trim().slice(0, 800);
  return note ? { claims: [{ fact: note, file: '' }], entryPoints: [], unknowns: [] } : { claims: [], entryPoints: [], unknowns: [] };
}

/** Drops any claim citing a file or line range the explorer wasn't actually shown. */
function validateClaims(output: ExplorerOutput, packedLines: Map<string, number>): { kept: Claim[]; dropped: number } {
  const kept: Claim[] = [];
  let dropped = 0;
  for (const c of output.claims) {
    if (!c.file) {
      kept.push(c); // uncited salvage note — kept but visibly unattributed, never silently dropped
      continue;
    }
    const totalLines = packedLines.get(c.file);
    if (totalLines === undefined) {
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

interface ExplorerRunResult {
  cluster: Cluster;
  kept: Claim[];
  entryPoints: EntryPoint[];
  unknowns: string[];
  skipped: string[];
  dropped: number;
  charsIn: number;
  charsOut: number;
  apiCalls: number;
  promptTokens: number;
  completionTokens: number;
}

const EMPTY_EXPLORER_USAGE = { apiCalls: 0, promptTokens: 0, completionTokens: 0 };

async function runOneExplorer(
  cluster: Cluster,
  userPrompt: string,
  model: string,
  baseURL: string,
  apiKeys: string[],
  cfg: ExplorationConfig,
  deps: ExplorationDeps
): Promise<ExplorerRunResult> {
  deps.onProgress?.(`Exploring ${cluster.key}…`);

  const { text: pack, packedLines, skipped } = await buildPack(cluster.files, cfg.explorerInputChars, deps);
  if (!pack.trim()) {
    return { cluster, kept: [], entryPoints: [], unknowns: [], skipped: cluster.files, dropped: 0, charsIn: 0, charsOut: 0, ...EMPTY_EXPLORER_USAGE };
  }

  const userContent =
    `Question: ${userPrompt}\n\nCluster: ${cluster.key}\n\n` +
    (skipped.length ? `(not included below — over budget: ${skipped.join(', ')})\n\n` : '') +
    pack;

  let raw = '';
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
            { role: 'system', content: EXPLORER_SYSTEM_PREAMBLE },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
          max_tokens: cfg.explorerMaxTokens,
          stream: false,
          ...((cfg.extraBody ?? {}) as any),
        });
      },
      deps.notifyRotate
    );
    raw = (response as any)?.choices?.[0]?.message?.content ?? '';
    const rawUsage = (response as any)?.usage;
    promptTokens = rawUsage?.prompt_tokens ?? 0;
    completionTokens = rawUsage?.completion_tokens ?? 0;
  } catch {
    // An explorer's completion failing must not fail the run — its files just
    // stay unexplored, same as any other tool-error degrade path here.
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
    completionTokens,
  };
}

// ── Merge — mechanical, no synthesizer call ──

function renderClaimTable(perCluster: ExplorerRunResult[], overflowFiles: string[], maxChars: number): string {
  const seen = new Set<string>();
  let out = '';
  for (const r of perCluster) {
    if (!r.kept.length && !r.entryPoints.length && !r.unknowns.length) continue;
    let section = `### ${r.cluster.key}\n`;
    for (const c of r.kept) {
      const dedupeKey = `${c.file}:${c.lines ?? ''}:${c.fact.slice(0, 60)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      section += c.file ? `- ${c.fact} (${c.file}${c.lines ? `:${c.lines}` : ''})\n` : `- ${c.fact} [uncited note]\n`;
    }
    for (const e of r.entryPoints) section += `- entry point: \`${e.symbol}\` (${e.file}:${e.line})\n`;
    for (const u of r.unknowns) section += `- unknown: ${u}\n`;
    if (r.skipped.length) section += `- not explored here (over budget): ${r.skipped.join(', ')}\n`;
    if (out.length + section.length > maxChars) break;
    out += section;
  }
  if (overflowFiles.length) {
    const line = `\nAlso matched, unexplored: ${overflowFiles.join(', ')}\n`;
    if (out.length + line.length <= maxChars) out += line;
  }
  return out.trim();
}

// ── Entry point ──

export async function runExplorationPhase(
  userPrompt: string,
  model: string,
  baseURL: string,
  apiKeys: string[],
  deps: ExplorationDeps,
  cfg: ExplorationConfig,
  isLocalProvider: boolean
): Promise<ExplorationResult> {
  try {
    // Pre-gate on workspace size, one tool call. hitCounts.size is bounded by
    // the number of files in the workspace, so a workspace smaller than
    // gateMinFiles can NEVER pass shouldExplore below — yet the scout would
    // still burn ~20 tool calls (one or two per extracted term) discovering
    // that. Observed in agent-evals: every run against the 4-file fixture
    // opened with the same 19-call scout prefix that was then thrown away.
    try {
      const inventory = (await deps.requestTool('find_files', { pattern: '**/*' })) as
        | { totalMatches?: number; files?: string[] }
        | null;
      const fileCount = inventory?.totalMatches ?? inventory?.files?.length;
      if (typeof fileCount === 'number' && fileCount < cfg.gateMinFiles) return EMPTY_RESULT;
    } catch {
      // Pre-gate is an optimization only — if the inventory call fails, fall
      // through to the scout, which tolerates per-term failures itself.
    }

    const hitCounts = await scout(userPrompt, deps);
    const { clusters, overflowFiles } = buildClusters(hitCounts, cfg.maxExplorers);
    if (!shouldExplore(hitCounts, clusters, cfg)) return EMPTY_RESULT;

    const runAll = async (): Promise<ExplorerRunResult[]> => {
      const runOne = (c: Cluster) => runOneExplorer(c, userPrompt, model, baseURL, apiKeys, cfg, deps);
      if (isLocalProvider) {
        // Sequential: local providers serialize inference anyway, and identical
        // system-preamble prefixes across explorers make sequential calls the
        // best case for prefix-cache reuse.
        const out: ExplorerRunResult[] = [];
        for (const c of clusters) out.push(await runOne(c));
        return out;
      }
      return Promise.all(clusters.map(runOne));
    };

    // Whole-phase timeout: on expiry, use whatever finished (nothing, if the
    // race resolves before any explorer does) rather than block the user's
    // turn on exploration. In-flight explorer calls are not cancelled — their
    // results are simply discarded, same cost as any other timeout.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), cfg.explorePhaseTimeoutMs));
    const settled = (await Promise.race([runAll().catch(() => null), timeout])) ?? [];

    // Either every explorer failed, or the phase timed out before any
    // finished — either way, degrade to the unchanged main loop.
    if (!settled.length) return EMPTY_RESULT;

    const claimTableMarkdown = renderClaimTable(settled, overflowFiles, cfg.claimTableMaxChars);
    const stats = settled.reduce<ExplorationStats>(
      (acc, r) => ({
        explorers: acc.explorers + 1,
        filesPacked: acc.filesPacked + (r.cluster.files.length - r.skipped.length),
        claimsKept: acc.claimsKept + r.kept.length,
        claimsDropped: acc.claimsDropped + r.dropped,
        charsIn: acc.charsIn + r.charsIn,
        charsOut: acc.charsOut + r.charsOut,
        apiCalls: acc.apiCalls + r.apiCalls,
        promptTokens: acc.promptTokens + r.promptTokens,
        completionTokens: acc.completionTokens + r.completionTokens,
      }),
      { explorers: 0, filesPacked: 0, claimsKept: 0, claimsDropped: 0, charsIn: 0, charsOut: 0, apiCalls: 0, promptTokens: 0, completionTokens: 0 }
    );

    return { claimTableMarkdown, stats };
  } catch {
    // This phase must never make a run worse than the status quo.
    return EMPTY_RESULT;
  }
}
