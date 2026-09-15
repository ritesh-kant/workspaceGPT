/**
 * Pre-fetch + agent benchmark — measures the path a documentation question
 * takes when a workspace folder is open: retrieval runs first, its results are
 * injected into the TOOL-enabled prompt, and the model may either answer from
 * that context or reach for its tools.
 *
 * This is the path the capability-from-facts change (chatService, 2026-09-05)
 * sends every doc question down when a folder is open. The risk it measures is
 * the one that decides whether that change holds: does a model handed both
 * context and tools still answer correctly and stay grounded — and does it
 * waste tool calls re-searching for what it already has?
 *
 * Same fixture corpus, queries and scoring as chat-response-bench.mjs, so the
 * numbers are directly comparable to that baseline (facts, grounded). Adds:
 *
 *   tool calls   — per query; a well-answered doc question needs none
 *   explored     — whether the codebase exploration phase ran (it must not, on
 *                  a doc question with context and no write intent)
 *   prompt tok   — cost of the tool prompt vs the plain RAG prompt
 *
 * `search_docs` is wired to the SAME fixture index, so a model that does
 * re-search still gets a real answer — the count is the signal, not a failure.
 *
 * Run: node src/chat/prefetch-agent-bench.mjs [--queries q01,q02] [--runs 1]
 *        [--delay-ms 0] [--topk 5] [--timeout-min 3]
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fork, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { loadEnv } from '../env.mjs';
import { buildFixtureIndex, EMBEDDING_DIR } from '../retrieval/build-fixture-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(pkgRoot, '../..');
const extRoot = path.join(repoRoot, 'apps/vscode-extensions');
const SEARCH_PROCESS = path.join(extRoot, 'dist/workers/common/searchProcess.js');
const queriesPath = path.join(pkgRoot, 'fixtures/retrieval/queries.json');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

loadEnv();
const TOPK = parseInt(argOf('topk', '5'), 10);
const RUNS = Math.max(1, parseInt(argOf('runs', '1'), 10) || 1);
const DELAY_MS = Math.max(0, parseInt(argOf('delay-ms', '0'), 10) || 0);
const ONLY = argOf('queries', null)?.split(',');
const QUERY_TIMEOUT_MS = Math.round(parseFloat(argOf('timeout-min', '3')) * 60 * 1000);

// The worker driver and headless tool host come from the smoke harness; the
// import is side-effect free (its run loop is behind an isMain guard).
const { runAgent } = await import('../headless/agent-smoke.mjs');

const log = (s) => console.log(s);

if (!fs.existsSync(SEARCH_PROCESS)) {
  console.error(`❌ ${path.relative(repoRoot, SEARCH_PROCESS)} does not exist — build the extension first (cd apps/vscode-extensions && node esbuild.config.js)`);
  process.exit(1);
}

// ── retrieval over the fixture index (same protocol as chat-response-bench) ──
await buildFixtureIndex({ log });
const child = fork(SEARCH_PROCESS, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
const waitFor = (types) =>
  new Promise((resolve, reject) => {
    const onMsg = (msg) => {
      if (types.includes(msg?.type)) {
        child.off('message', onMsg);
        msg.type === 'error' ? reject(new Error(msg.message)) : resolve(msg);
      }
    };
    child.on('message', onMsg);
  });
const ready = waitFor(['ready', 'error']);
child.send({ type: 'init', embeddingDirPath: EMBEDDING_DIR, namespace: 'CONFLUENCE', provider: 'local' });
await ready;
async function search(query, topK) {
  const res = waitFor(['results', 'error']);
  child.send({ type: 'search', query, topK });
  return (await res).data;
}
await search('warmup query please ignore', 1);

// ── a small, irrelevant workspace: tools exist, but the answer is not in it ──
function makeWorkspace() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prefetch-bench-'));
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/math.js'), 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(d, 'src/app.js'), "const { add } = require('./math');\nconsole.log(add(2, 3));\n");
  fs.writeFileSync(path.join(d, 'README.md'), '# demo\nA tiny arithmetic demo.\n');
  for (const args of [['init', '--quiet'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', '-A'], ['commit', '--quiet', '-m', 'fixture']]) {
    execFileSync('git', ['-C', d, ...args]);
  }
  return d;
}

// ── scoring (identical to chat-response-bench) ─────────────────────────────
function scoreFacts(answer, expectedFacts = []) {
  const found = expectedFacts.filter((f) => new RegExp(f, 'i').test(answer));
  return { factsTotal: expectedFacts.length, factsFound: found.length, missingFacts: expectedFacts.filter((f) => !found.includes(f)) };
}
function scoreGroundedness(answer, injectedFileNames) {
  const cited = [...new Set([...(answer.match(/\b[\w][\w-]*\.md\b/gi) ?? []), ...(answer.match(/\bADO-\d+\b/gi) ?? [])])];
  if (!cited.length) return { citations: [], ungrounded: [], grounded: null };
  const injected = new Set(injectedFileNames.flatMap((f) => [f.toLowerCase(), `${f.toLowerCase()}.md`, f.toLowerCase().replace(/\.md$/, '')]));
  const ungrounded = cited.filter((c) => !injected.has(c.toLowerCase()));
  return { citations: cited, ungrounded, grounded: ungrounded.length === 0 };
}

// ── run ────────────────────────────────────────────────────────────────────
let queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
if (ONLY) queries = queries.filter((q) => ONLY.includes(q.id));

const records = [];
let started = 0;
for (let runIndex = 1; runIndex <= RUNS; runIndex++) {
  for (const q of queries) {
    if (started++ && DELAY_MS) await new Promise((res) => setTimeout(res, DELAY_MS));
    const results = await search(q.query, TOPK);
    const injectedFileNames = results.map((r) => r.data.fileName);
    const retrievalHit = injectedFileNames.some((f) => q.expected.includes(f) || q.expected.includes(`${f}.md`) || q.expected.includes(f.replace(/\.md$/, '')));

    const ws = makeWorkspace();
    const t0 = Date.now();
    const r = await Promise.race([
      runAgent(
        ws,
        q.query,
        () => {},
        { searchResults: results, toolAvailability: { codebase: true, confluence: true, tickets: false } },
        {
          // Real, same-index search — so a model that re-searches gets a real
          // answer and the re-search shows up as a counted tool call.
          search_docs: async ({ query, topK }) => ({
            results: (await search(String(query ?? ''), Math.min(Math.max(topK ?? 5, 1), 10))).map((x) => ({
              source: x.data?.source,
              title: x.data?.title ?? x.data?.fileName,
              url: x.data?.url,
              text: x.text,
            })),
          }),
        }
      ),
      new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout', toolCalls: [], metrics: null }), QUERY_TIMEOUT_MS)),
    ]);
    const totalMs = Date.now() - t0;
    const answer = r.answer ?? '';
    const facts = scoreFacts(answer, q.expectedFacts);
    // Unlike the RAG bench, this path HAS a workspace, and a model that looked
    // at it may legitimately mention its files ("see README.md"). Those are
    // real, verifiable citations, not fabricated docs — grounded. Only names
    // that are neither an injected doc nor a workspace file count against it.
    const workspaceFiles = fs.readdirSync(ws, { recursive: true }).map((p) => path.basename(String(p)));
    const grounding = scoreGroundedness(answer, [...injectedFileNames, ...workspaceFiles]);
    const m = r.metrics ?? {};
    const toolNames = (r.toolCalls ?? []).map((c) => c.name);
    const explored = !!m.exploration;
    const promptTokens = m.promptTokensTotal ?? m.promptTokens ?? null;

    log(
      `[run ${runIndex}/${RUNS}] ${q.id} ${r.ok ? 'ok' : `ERROR(${r.error})`} · ${totalMs}ms · facts ${facts.factsFound}/${facts.factsTotal} · ` +
        `grounded ${grounding.grounded === null ? 'n/a' : grounding.grounded} · tools ${toolNames.length}${toolNames.length ? ` [${toolNames.join(',')}]` : ''} · ` +
        `explored ${explored} · promptTok ${promptTokens ?? '—'}${retrievalHit ? '' : ' · ⚠ retrieval miss'}`
    );
    records.push({ runIndex, queryId: q.id, query: q.query, ok: r.ok, error: r.error ?? null, totalMs, ...facts, grounded: grounding.grounded, ungrounded: grounding.ungrounded, toolCalls: toolNames, explored, promptTokens, retrievalHit });
  }
}
child.kill();

// ── report ─────────────────────────────────────────────────────────────────
const served = records.filter((r) => r.ok);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const factsFound = served.reduce((a, r) => a + r.factsFound, 0);
const factsTotal = served.reduce((a, r) => a + r.factsTotal, 0);
const groundedRows = served.filter((r) => r.grounded !== null);
const summary = {
  queries: records.length,
  ok: pct(served.length, records.length),
  retrievalHit: pct(records.filter((r) => r.retrievalHit).length, records.length),
  factsScore: pct(factsFound, factsTotal),
  grounded: pct(groundedRows.filter((r) => r.grounded).length, groundedRows.length),
  zeroToolAnswers: pct(served.filter((r) => r.toolCalls.length === 0).length, served.length),
  medianToolCalls: median(served.map((r) => r.toolCalls.length)),
  explored: pct(served.filter((r) => r.explored).length, served.length),
  medianPromptTokens: median(served.map((r) => r.promptTokens)),
  medianTotalMs: median(served.map((r) => r.totalMs)),
};
log('\n━━ summary');
for (const [k, v] of Object.entries(summary)) log(`   ${k}: ${v}`);

const outDir = path.join(pkgRoot, 'results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'prefetch-agent.json'), JSON.stringify({ run: new Date().toISOString(), summary, records }, null, 2));
const problems = records.filter((r) => !r.ok || r.factsFound < r.factsTotal || r.grounded === false);
fs.writeFileSync(
  path.join(outDir, 'prefetch-agent.md'),
  `# Pre-fetch + agent benchmark\n\nRun: ${new Date().toISOString()} · path: retrieval → tool-enabled prompt with injected context (modelWorker.js, real headless tool host) · topK: ${TOPK}\n\n` +
    `| queries | ok | retrieval hit | facts score | grounded | zero-tool answers | tool calls (median) | explored | prompt tok (median) | total ms (median) |\n|---|---|---|---|---|---|---|---|---|---|\n` +
    `| ${summary.queries} | ${summary.ok} | ${summary.retrievalHit} | ${summary.factsScore} | ${summary.grounded} | ${summary.zeroToolAnswers} | ${summary.medianToolCalls ?? '—'} | ${summary.explored} | ${summary.medianPromptTokens ?? '—'} | ${summary.medianTotalMs ?? '—'} |\n\n` +
    `## Problems\n\n${problems.length ? problems.map((p) => `- **${p.queryId} (run ${p.runIndex})** "${p.query}" — ${p.ok ? '' : `error: ${p.error}; `}${p.factsFound < p.factsTotal ? `missing facts: ${p.missingFacts.join(' · ')}; ` : ''}${p.grounded === false ? `ungrounded: ${p.ungrounded.join(', ')}` : ''}`).join('\n') : '- none'}\n`
);
log(`\nreport → results/prefetch-agent.json, results/prefetch-agent.md`);

// Exit non-zero on a quality regression among SERVED queries only — a 429 is a
// provider condition, not an answer-quality signal (see chat-response-bench).
process.exit(served.every((r) => r.factsFound === r.factsTotal && r.grounded !== false) ? 0 : 1);
