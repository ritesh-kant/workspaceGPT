import OpenAI from 'openai';
import { withKeyFailover } from '../../utils/apiKeyFailover';
import { getProviderDefaultHeaders } from '../../utils/anthropicHeaders';
import { extractBalancedJsonObjects } from './jsonExtract';

/**
 * Exploration decomposition — see docs/design/exploration-decomposition.md.
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

/** Per-file line slice an explorer reads — see the read_file call in runOneExplorer. */
const EXPLORER_FILE_MAX_LINES = 400;

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
  /**
   * A scout term matching more files than this is treated as pure noise and
   * contributes nothing to file ranking (see termWeight).
   */
  noiseTermMaxFiles: number;
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
    noiseTermMaxFiles: 200,
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
  // Continuation/approval vocabulary. A reply like "continue" or "go ahead"
  // has no topic of its own, but every one of these words appears in ordinary
  // source ("continue;", "proceed()") — so scouting on them matches a large
  // slice of the workspace and passes the spread gate below on pure noise.
  // Observed: a bare "continue" after a failed run scouted the whole monorepo
  // and spent six explorer completions on files chosen for containing that word.
  'continue', 'proceed', 'ahead', 'okay', 'yeah', 'sure', 'yes', 'keep',
  'going', 'done', 'thanks', 'again', 'that', 'this', 'them', 'those', 'good',
  // Task-scaffolding vocabulary. Seeded ticket prompts ("Work on ticket 1234
  // (…) — read the ticket, find the code it affects, propose a plan…") are
  // mostly made of these words, and each one that survives extraction takes a
  // slot from the ticket's actual subject nouns. Observed live: "Work",
  // "ticket", "read" and "find" were scouted while "variant" — the word the
  // ticket was ABOUT — fell off the end of the term cap.
  'work', 'working', 'ticket', 'tickets', 'read', 'find', 'affects', 'affect',
  'propose', 'proposed', 'plan', 'plans', 'changing', 'change', 'changes',
  'anything', 'implement', 'implementing', 'show', 'shows', 'diffs', 'diff',
  'guessing', 'unclear', 'ambiguous', 'instead', 'behind', 'design',
]);

/**
 * Terms scouted per question. Raised from 12: the cut below is by term shape
 * and length rather than prompt order, and each extra term costs only a local
 * ripgrep call.
 */
const MAX_SCOUT_TERMS = 16;

/**
 * Extracts search terms from a user question — deterministic, no model call.
 *
 * Order decides survival: the final slice keeps the FRONT of the list, so
 * identifier-shaped tokens (camelCase, snake_case, dotted, quoted — the
 * rarest, highest-signal shapes) come first, then plain words longest-first.
 * The old prompt-order slice filled the cap with the sentence's scaffolding
 * ("Work on ticket …") and cut the discriminating nouns in a trailing
 * parenthetical — observed live: "variant"/"variants" dropped from a ticket
 * titled "default selected product variant" while "Work" was scouted.
 *
 * Exported for the headless eval harness (packages/agent-evals).
 */
export function extractSearchTerms(prompt: string): string[] {
  const identifiers = new Set<string>();
  const words = new Set<string>();
  const add = (set: Set<string>, t: string) => {
    const s = t.trim();
    // Pure numbers are fetch keys (ticket IDs, ports), not code search terms —
    // text-searching "1324128" matches lockfiles and hashes, never the fix.
    if (s.length >= 3 && !/^\d+$/.test(s)) set.add(s);
  };

  // camelCase / PascalCase identifiers (e.g. "LeadsView", "fetchData")
  for (const m of prompt.matchAll(/\b[A-Za-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) add(identifiers, m[0]);
  // snake_case identifiers
  for (const m of prompt.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi)) add(identifiers, m[0]);
  // dotted tokens / filenames (api.ts, foo.bar)
  for (const m of prompt.matchAll(/\b[\w-]+\.[\w.-]{1,10}\b/g)) add(identifiers, m[0]);
  // quoted phrases
  for (const m of prompt.matchAll(/"([^"]{2,40})"|'([^']{2,40})'/g)) add(identifiers, m[1] ?? m[2] ?? '');
  // remaining informative words
  for (const w of prompt.split(/[^A-Za-z0-9_]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w.toLowerCase())) add(words, w);
  }

  // Longer plain words are rarer, and rare is exactly what a text scout wants;
  // a word already captured as an identifier doesn't need a second slot.
  const plainWords = [...words].filter((w) => !identifiers.has(w)).sort((a, b) => b.length - a.length);
  return [...identifiers, ...plainWords].slice(0, MAX_SCOUT_TERMS);
}

/** A term that looks like an identifier is worth a symbol lookup too, not just text search. */
function looksLikeIdentifier(term: string): boolean {
  return /[A-Z_]/.test(term) || term.includes('.');
}

/**
 * How much one file-hit from a term is worth, given how many files that term
 * matched in total. Every term used to score a flat 1 per file, so files dense
 * in generic vocabulary mechanically outranked the actually-relevant component
 * — observed live on a PLP pricing bug: GraphQL schema files beat
 * ProductTile.tsx because they matched six generic terms ("price", "product",
 * "default", …) while the one discriminating term was never scouted. A term
 * matching 3 files is a laser; one matching 120 is background hum; one above
 * `noiseCeiling` says nothing at all.
 *
 * Exported for the headless eval harness (packages/agent-evals).
 */
export function termWeight(fileCount: number, noiseCeiling = 200): number {
  if (fileCount <= 0 || fileCount > noiseCeiling) return 0;
  if (fileCount <= 3) return 3;
  if (fileCount <= 15) return 2;
  if (fileCount <= 60) return 1;
  return 0.25;
}

/**
 * Deterministic, zero-model-token survey of which files are relevant to the
 * question. Two passes: collect every term's matches FIRST, then score — a
 * term's weight depends on its total spread (termWeight above), which isn't
 * known until its search returns.
 *
 * Exported for the headless eval harness (packages/agent-evals).
 */
export async function scout(
  prompt: string,
  deps: ExplorationDeps,
  noiseCeiling = 200
): Promise<Map<string, number>> {
  const terms = extractSearchTerms(prompt);
  const textHits = new Map<string, string[]>();
  const symbolHits = new Map<string, string[]>();

  await Promise.all(
    terms.map(async (term) => {
      try {
        const r = (await deps.requestTool('search_codebase', {
          query: term,
          outputMode: 'files_with_matches',
        })) as { files?: string[] } | null;
        textHits.set(term, (r?.files ?? []).filter(Boolean));
      } catch {
        // Scouting is best-effort — a failed lookup just yields fewer hits, never an error.
      }
      if (looksLikeIdentifier(term)) {
        try {
          const r = (await deps.requestTool('find_symbol', { query: term })) as
            | { symbols?: { file: string }[] }
            | null;
          symbolHits.set(term, (r?.symbols ?? []).map((sym) => sym.file).filter(Boolean));
        } catch {
          // best-effort
        }
      }
    })
  );

  // A term with zero hits so far gets one filename-pattern fallback — a doc
  // can describe a feature in prose that never appears verbatim in the file
  // that implements it. Capped: this is a fallback, not the main search.
  const nameHits = new Map<string, string[]>();
  const misses = terms
    .filter((t) => !(textHits.get(t)?.length || symbolHits.get(t)?.length))
    .slice(0, 5);
  await Promise.all(
    misses.map(async (term) => {
      try {
        const r = (await deps.requestTool('find_files', { pattern: `**/*${term}*` })) as
          | { files?: string[] }
          | null;
        nameHits.set(term, (r?.files ?? []).filter(Boolean));
      } catch {
        // best-effort
      }
    })
  );

  const hitCounts = new Map<string, number>();
  const bump = (file: string, weight: number) => {
    if (!file || weight <= 0) return;
    hitCounts.set(file, (hitCounts.get(file) ?? 0) + weight);
  };
  for (const files of textHits.values()) {
    const weight = termWeight(files.length, noiseCeiling);
    for (const f of files) bump(f, weight);
  }
  for (const files of symbolHits.values()) {
    if (!files.length || files.length > noiseCeiling) continue;
    // A symbol-index hit is a stronger signal than a text match, but a query
    // matching hundreds of symbols is as generic as any noisy text term.
    const weight = 2 * Math.max(termWeight(files.length, noiseCeiling), 0.5);
    for (const f of files) bump(f, weight);
  }
  for (const files of nameHits.values()) {
    if (!files.length || files.length > noiseCeiling) continue;
    // A filename containing the term is meaningful even when the term is
    // common prose; these lists are small by construction.
    const weight = Math.max(termWeight(files.length, noiseCeiling), 0.5);
    for (const f of files) bump(f, weight);
  }
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

  // Pack order matters: buildPack fills a fixed character budget front-first,
  // so a cluster's highest-scoring files must come first or one big low-signal
  // file crowds out the file the question is actually about.
  for (const c of clusters) {
    c.files.sort((a, b) => (hitCounts.get(b) ?? 0) - (hitCounts.get(a) ?? 0));
  }

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
      // Explicit slice, not read_file's default. P4 raised that default to
      // 2000 lines / 64 KB so the MAIN loop stops paging through a file in
      // fragments — but an explorer's job is breadth over a cluster of files
      // within a fixed char budget, and one 64 KB file would swallow the
      // whole thing and push the rest onto `skipped`. Explorers keep the
      // slice size they were tuned with.
      const r = (await deps.requestTool('read_file', { path: file, endLine: EXPLORER_FILE_MAX_LINES })) as
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

export interface Claim {
  fact: string;
  file: string;
  lines?: string;
}
export interface EntryPoint {
  symbol: string;
  file: string;
  line: number;
}
export interface ExplorerOutput {
  claims: Claim[];
  entryPoints: EntryPoint[];
  unknowns: string[];
}

/**
 * Parses the explorer's JSON contract, tolerating the same fence/tag noise
 * local models produce elsewhere.
 *
 * Exported for the callable `explore` sub-agent (exploreSubagent.ts), which
 * answers on the same claim contract. One parser and one validator for both
 * means a claim citing a file nobody opened is dropped the same way whether
 * it came from the pre-loop phase or from a mid-run delegation.
 */
export function parseExplorerOutput(raw: string): ExplorerOutput {
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
export function validateClaims(output: ExplorerOutput, packedLines: Map<string, number>): { kept: Claim[]; dropped: number } {
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
        const openai = new OpenAI({
          apiKey,
          baseURL,
          defaultHeaders: getProviderDefaultHeaders(baseURL, apiKey),
        });
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
  isLocalProvider: boolean,
  /**
   * Extra grounding text scouted ALONGSIDE the prompt and shown to explorers —
   * typically the ticket behind the task (title, description, acceptance
   * criteria). A seeded ticket prompt carries only an ID and a title; the body
   * is where the discriminating vocabulary lives ("strike-through", "unit
   * label"), so scouting the prompt alone maps the wrong territory.
   */
  groundingText?: string
): Promise<ExplorationResult> {
  try {
    const scoutSource = groundingText ? `${userPrompt}\n${groundingText}` : userPrompt;
    // Nothing informative to scout on — a reply that is all stopwords ("go
    // ahead", "do that too") gives the scout no term to search, and the phase
    // can only produce noise from it. Bail before the inventory call below.
    if (extractSearchTerms(scoutSource).length === 0) return EMPTY_RESULT;

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

    const hitCounts = await scout(scoutSource, deps, cfg.noiseTermMaxFiles);
    const { clusters, overflowFiles } = buildClusters(hitCounts, cfg.maxExplorers);
    if (!shouldExplore(hitCounts, clusters, cfg)) return EMPTY_RESULT;

    // Explorers answer the user's question, but the ticket's symptom text is
    // often the better statement of it — include a bounded slice.
    const explorerQuestion = groundingText
      ? `${userPrompt}\n\nTicket behind this task (from the issue tracker):\n${groundingText.slice(0, 1500)}`
      : userPrompt;
    const runAll = async (): Promise<ExplorerRunResult[]> => {
      const runOne = (c: Cluster) => runOneExplorer(c, explorerQuestion, model, baseURL, apiKeys, cfg, deps);
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
