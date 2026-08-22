/**
 * Retrieval-quality eval for the docs/tickets vector search — drives the REAL
 * dist/workers/common/searchProcess.js (real embedding, real cosine +
 * lexical-boost scoring) against the fixture corpus built by
 * build-fixture-index.mjs, using a hand-labeled query→expected-fileName set
 * (fixtures/retrieval/queries.json).
 *
 * With --rerank, each query's raw results are ALSO run through the real
 * reranker/queryPlanner/queryClassifier pipeline (classifyQuery → buildPlan →
 * rerank), quantifying what the cosine/BM25 blend in RETRIEVAL_THRESHOLDS
 * actually buys over the raw vector search — same real modules chatService.ts
 * wires together, loaded headlessly via build-units.mjs.
 *
 * Run: node src/retrieval/retrieval-eval.mjs [--topk 10] [--rerank] [--rebuild-index] [--queries q01,q07]
 */
import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { buildFixtureIndex, EMBEDDING_DIR } from './build-fixture-index.mjs';
import { buildUnits } from '../headless/build-units.mjs';

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
const TOPK = parseInt(argOf('topk', '10'), 10);
const WITH_RERANK = argv.includes('--rerank');
const REBUILD_INDEX = argv.includes('--rebuild-index');
const ONLY = argOf('queries', null)?.split(',') ?? null;

const log = (s) => console.log(s);

// ── build/reuse the fixture index ─────────────────────────────────────────

const corpusHash = await buildFixtureIndex({ force: REBUILD_INDEX, log });

if (!fs.existsSync(SEARCH_PROCESS)) {
  console.error(
    `❌ ${path.relative(repoRoot, SEARCH_PROCESS)} does not exist — build the extension's worker bundles first:\n` +
      `   cd apps/vscode-extensions && node esbuild.config.js`,
  );
  process.exit(1);
}

let rerankModules = null;
if (WITH_RERANK) {
  const outDir = await buildUnits();
  rerankModules = {
    classifyQuery: (await import(path.join(outDir, 'queryClassifier.mjs'))).classifyQuery,
    buildPlan: (await import(path.join(outDir, 'queryPlanner.mjs'))).buildPlan,
    rerank: (await import(path.join(outDir, 'reranker.mjs'))).rerank,
  };
}

// ── search child process ──────────────────────────────────────────────────

function forkSearchProcess() {
  const child = fork(SEARCH_PROCESS, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stderr?.on('data', (d) => process.env.VERBOSE && log(`  [search:stderr] ${d.toString().trimEnd()}`));
  child.stdout?.on('data', (d) => process.env.VERBOSE && log(`  [search] ${d.toString().trimEnd()}`));

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

  return { child, waitFor };
}

const { child, waitFor } = forkSearchProcess();
const ready = waitFor(['ready', 'error']);
child.send({ type: 'init', embeddingDirPath: EMBEDDING_DIR, namespace: 'CONFLUENCE', provider: 'local' });
await ready;
log('retrieval-eval: search process ready');

async function search(query, topK) {
  const started = Date.now();
  const res = waitFor(['results', 'error']);
  child.send({ type: 'search', query, topK });
  const msg = await res;
  return { latencyMs: Date.now() - started, results: msg.data };
}

// Warm-up query — discarded. `initializeProvider` in the real worker already
// warms the ONNX model on init, but the first end-to-end search still JITs
// the local scoring path (typed-array allocation, etc).
await search('warmup query please ignore', 1);

// ── run queries ────────────────────────────────────────────────────────────

let queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
if (ONLY) queries = queries.filter((q) => ONLY.includes(q.id));

function rankOf(fileNames, expected) {
  const idx = fileNames.findIndex((f) => expected.includes(f));
  return idx === -1 ? null : idx + 1;
}

const records = [];
for (const q of queries) {
  const { latencyMs, results } = await search(q.query, Math.max(TOPK, 10));
  const rawFiles = results.map((r) => r.data.fileName);
  const rawRank = rankOf(rawFiles, q.expected);

  let rerankedRank = null;
  let rerankedFiles = null;
  if (WITH_RERANK) {
    const classification = rerankModules.classifyQuery(q.query, ['CONFLUENCE']);
    const plan = rerankModules.buildPlan(classification);
    const reranked = rerankModules.rerank(q.query, results, { ...plan, finalTopK: Math.max(TOPK, plan.finalTopK) });
    rerankedFiles = reranked.map((r) => r.data.fileName);
    rerankedRank = rankOf(rerankedFiles, q.expected);
  }

  log(
    `${q.id} [${q.kind}] "${q.query}" — raw rank=${rawRank ?? 'miss'}` +
      (WITH_RERANK ? `  reranked rank=${rerankedRank ?? 'miss'}` : '') +
      `  (${latencyMs}ms)`,
  );

  records.push({
    id: q.id,
    query: q.query,
    kind: q.kind,
    expected: q.expected,
    latencyMs,
    raw: { rank: rawRank, top: rawFiles.slice(0, 5) },
    reranked: WITH_RERANK ? { rank: rerankedRank, top: rerankedFiles.slice(0, 5) } : null,
  });
}

child.kill();

// ── metrics ────────────────────────────────────────────────────────────────

const recallAt = (recs, stage, k) => recs.filter((r) => r[stage].rank !== null && r[stage].rank <= k).length / (recs.length || 1);
const mrrAt = (recs, stage, k) => {
  const c = recs.map((r) => (r[stage].rank !== null && r[stage].rank <= k ? 1 / r[stage].rank : 0));
  return c.reduce((a, b) => a + b, 0) / (c.length || 1);
};
const percentile = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function summarize(recs, stage) {
  return {
    queries: recs.length,
    recallAt1: recallAt(recs, stage, 1),
    recallAt3: recallAt(recs, stage, 3),
    recallAt5: recallAt(recs, stage, 5),
    mrrAt10: mrrAt(recs, stage, 10),
    byKind: Object.fromEntries(
      [...new Set(recs.map((r) => r.kind))].map((k) => {
        const sub = recs.filter((r) => r.kind === k);
        return [k, { recallAt3: recallAt(sub, stage, 3), mrrAt10: mrrAt(sub, stage, 10), queries: sub.length }];
      }),
    ),
  };
}

const latencies = records.map((r) => r.latencyMs);
const stageResult = {
  stage: 'raw',
  corpusHash,
  ranAt: new Date().toISOString(),
  ...summarize(records, 'raw'),
  latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  misses: records.filter((r) => r.raw.rank === null).map((r) => ({ id: r.id, expected: r.expected, got: r.raw.top })),
};
const stages = [stageResult];
if (WITH_RERANK) {
  stages.push({
    stage: 'reranked',
    corpusHash,
    ranAt: new Date().toISOString(),
    ...summarize(records, 'reranked'),
    latency: { p50: null, p95: null }, // rerank is in-process re-scoring of the same fetched results, not separately timed
    misses: records.filter((r) => r.reranked.rank === null).map((r) => ({ id: r.id, expected: r.expected, got: r.reranked.top })),
  });
}

log(`\n━━ summary`);
for (const s of stages) {
  log(
    `   ${s.stage}: recall@1=${s.recallAt1.toFixed(2)} recall@3=${s.recallAt3.toFixed(2)} recall@5=${s.recallAt5.toFixed(2)} ` +
      `MRR@10=${s.mrrAt10.toFixed(2)}` +
      (s.latency.p50 !== null ? ` p50=${s.latency.p50}ms p95=${s.latency.p95}ms` : ''),
  );
}

// ── results (merge-on-rerun, keyed by stage|corpusHash — see run.mjs) ──────

const resultsDir = path.join(pkgRoot, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, 'retrieval-eval.json');
const ranKeys = new Set(stages.map((s) => `${s.stage}|${s.corpusHash}`));
let merged = stages;
if (fs.existsSync(jsonPath)) {
  const prior = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  merged = [...prior.filter((s) => !ranKeys.has(`${s.stage}|${s.corpusHash}`)), ...stages];
}
fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2));

let md = `# Retrieval-quality eval\n\nRun: ${new Date().toISOString()} · corpus: fixtures/retrieval/corpus (${queries.length} of ${JSON.parse(fs.readFileSync(queriesPath, 'utf8')).length} queries ran) · topK=${TOPK}\n\n`;
md += `| stage | corpus | recall@1 | recall@3 | recall@5 | MRR@10 | p50 ms | p95 ms |\n|---|---|---|---|---|---|---|---|\n`;
for (const s of merged) {
  md += `| ${s.stage} | ${s.corpusHash.slice(0, 10)} | ${s.recallAt1.toFixed(2)} | ${s.recallAt3.toFixed(2)} | ${s.recallAt5.toFixed(2)} | ${s.mrrAt10.toFixed(2)} | ${s.latency.p50 ?? '—'} | ${s.latency.p95 ?? '—'} |\n`;
}
md += `\n## By query kind (latest run per stage)\n\n| stage | kind | recall@3 | MRR@10 | queries |\n|---|---|---|---|---|\n`;
for (const s of stages) {
  for (const [kind, k] of Object.entries(s.byKind)) {
    md += `| ${s.stage} | ${kind} | ${k.recallAt3.toFixed(2)} | ${k.mrrAt10.toFixed(2)} | ${k.queries} |\n`;
  }
}
md += `\n## Misses (latest run)\n\n`;
for (const s of stages) {
  if (!s.misses.length) continue;
  md += `**${s.stage}:**\n`;
  for (const m of s.misses) md += `- ${m.id} — expected ${m.expected.join(', ')}, got [${m.got.join(', ')}]\n`;
}
fs.writeFileSync(path.join(resultsDir, 'retrieval-eval.md'), md);

log(`\nreport → results/retrieval-eval.json, results/retrieval-eval.md`);
process.exit(0);
