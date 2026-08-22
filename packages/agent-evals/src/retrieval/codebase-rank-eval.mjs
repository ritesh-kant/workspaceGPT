/**
 * A/B eval for the codebase-aware ranking added in commit 28ceeda
 * (rankTokenMatches/rankTokenFiles in codebaseTools.ts). Drives the REAL
 * `searchCodebase` (real ripgrep, real ranking code) against a fixture
 * mini-monorepo (fixtures/codebase-corpus) designed so the exact-phrase
 * search misses (forcing the token-union fallback the ranking only applies
 * to) and the answer file is heavily outnumbered by noise files that share
 * one of the two query tokens but not the other.
 *
 * Toggles ranking off via WGPT_DISABLE_CODEBASE_RANKING=1 (a seam added to
 * codebaseTools.ts purely for this eval — nothing in the extension itself
 * sets it) to compare "baseline" (ripgrep's raw traversal order) against
 * "ranked" (current production behavior) on the same queries.
 *
 * Run: node src/retrieval/codebase-rank-eval.mjs
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { buildUnits } from '../headless/build-units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(pkgRoot, '../..');
const extRoot = path.join(repoRoot, 'apps/vscode-extensions');
const fixtureDir = path.join(pkgRoot, 'fixtures/codebase-corpus');
const queriesPath = path.join(pkgRoot, 'fixtures/retrieval/codebase-queries.json');

// Preflight: confirm @vscode/ripgrep actually resolves to a real binary on
// disk. If this ever fails, searchCodebase silently falls back to the pure-JS
// scanner (a different code path — one that doesn't even implement the same
// exact-phrase-then-token-fallback shape the same way) and every number below
// would silently measure the wrong thing. Must resolve from the extension's
// own node_modules (same as build-units.mjs) — @vscode/ripgrep isn't hoisted
// to this package.
const require = createRequire(path.join(extRoot, 'package.json'));
let rgBinaryPath;
try {
  const modPath = require.resolve('@vscode/ripgrep');
  ({ rgPath: rgBinaryPath } = await import(modPath));
  if (!rgBinaryPath || !fs.existsSync(rgBinaryPath)) throw new Error('rgPath does not exist on disk');
} catch (e) {
  console.error(
    `❌ Preflight failed: @vscode/ripgrep did not resolve to a real binary (${e.message}).\n` +
      `   This eval requires real ripgrep — the JS-scan fallback path is not equivalent and would\n` +
      `   silently invalidate every number below. Check node_modules under apps/vscode-extensions.`,
  );
  process.exit(1);
}

const outDir = await buildUnits();
const codebaseTools = await import(path.join(outDir, 'codebaseTools.mjs'));

const queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));
const roots = [{ name: 'codebase-corpus', uri: { fsPath: fixtureDir } }];

function filesFromResult(result, outputMode) {
  return outputMode === 'files_with_matches' ? (result.files ?? []) : result.matches.map((m) => m.file);
}

function rankOf(files, expectedFiles) {
  const idx = files.findIndex((f) => expectedFiles.includes(f));
  return idx === -1 ? null : idx + 1; // 1-based, null = not found
}

async function runArm(query, disableRanking) {
  if (disableRanking) process.env.WGPT_DISABLE_CODEBASE_RANKING = '1';
  else delete process.env.WGPT_DISABLE_CODEBASE_RANKING;
  const result = await codebaseTools.searchCodebase(query.args, roots);
  const files = filesFromResult(result, query.args.outputMode);
  const rank = rankOf(files, query.expectedFiles);
  return {
    rank,
    recallAt5: rank !== null && rank <= 5,
    recallAt10: rank !== null && rank <= 10,
    totalResults: files.length,
    distinctFiles: [...new Set(files)],
    truncated: !!result.truncated,
    note: result.note,
  };
}

const log = (s) => console.log(s);
log(`codebase-rank-eval: ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} against ${path.relative(pkgRoot, fixtureDir)}`);
log(`ripgrep: ${rgBinaryPath}`);

const records = [];
for (const q of queries) {
  const baseline = await runArm(q, true);
  const ranked = await runArm(q, false);
  delete process.env.WGPT_DISABLE_CODEBASE_RANKING;

  const sameSet =
    baseline.distinctFiles.length === ranked.distinctFiles.length &&
    baseline.distinctFiles.every((f) => ranked.distinctFiles.includes(f));
  // The "ranking only reorders, never filters" invariant only holds on the
  // UNtruncated result — when either arm hit the match cap (MAX_MATCHES=50
  // for content mode), ranking legitimately changes which items survive
  // truncation by design (that's the entire point: surface the better
  // matches within the capped window). A differing set there is expected,
  // not a bug.
  const eitherTruncated = baseline.truncated || ranked.truncated;
  const invariantHolds = eitherTruncated || sameSet;

  log(`\n━━ ${q.id} (${q.args.outputMode}) — "${q.args.query}"`);
  log(`   baseline: rank=${baseline.rank ?? 'not found'}  ranked: rank=${ranked.rank ?? 'not found'}`);
  if (eitherTruncated) {
    log(`   (result capped/truncated on at least one arm — differing result sets here are expected, not a bug)`);
  } else if (!sameSet) {
    log(`   ⚠️  ranking must only REORDER untruncated results, never filter — baseline=${baseline.distinctFiles.length} files, ranked=${ranked.distinctFiles.length} files`);
  } else {
    log(`   same result set: yes`);
  }

  records.push({
    queryId: q.id,
    query: q.args.query,
    outputMode: q.args.outputMode,
    expectedFiles: q.expectedFiles,
    ranAt: new Date().toISOString(),
    baseline,
    ranked,
    sameResultSet: sameSet,
    truncated: eitherTruncated,
    invariantHolds,
  });
}

// ── aggregate ──────────────────────────────────────────────────────────

const mrr = (recs, arm) => {
  const contribs = recs.map((r) => (r[arm].rank ? 1 / r[arm].rank : 0));
  return contribs.reduce((a, b) => a + b, 0) / (contribs.length || 1);
};
const recallAt = (recs, arm, k) => {
  const key = k === 5 ? 'recallAt5' : 'recallAt10';
  return recs.filter((r) => r[arm][key]).length / (recs.length || 1);
};
const meanRankDelta = (recs) => {
  const deltas = recs
    .filter((r) => r.baseline.rank !== null && r.ranked.rank !== null)
    .map((r) => r.ranked.rank - r.baseline.rank);
  return deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
};

const summary = {
  queries: records.length,
  baseline: { mrr: mrr(records, 'baseline'), recallAt5: recallAt(records, 'baseline', 5), recallAt10: recallAt(records, 'baseline', 10) },
  ranked: { mrr: mrr(records, 'ranked'), recallAt5: recallAt(records, 'ranked', 5), recallAt10: recallAt(records, 'ranked', 10) },
  meanRankDelta: meanRankDelta(records), // negative = ranking moved the answer UP (better)
  invariantHolds: records.every((r) => r.invariantHolds),
};

log(`\n━━ summary`);
log(`   baseline: MRR=${summary.baseline.mrr.toFixed(2)} recall@5=${summary.baseline.recallAt5.toFixed(2)} recall@10=${summary.baseline.recallAt10.toFixed(2)}`);
log(`   ranked:   MRR=${summary.ranked.mrr.toFixed(2)} recall@5=${summary.ranked.recallAt5.toFixed(2)} recall@10=${summary.ranked.recallAt10.toFixed(2)}`);
log(`   mean rank delta (ranked − baseline, negative = improvement): ${summary.meanRankDelta ?? 'n/a (one arm never found the answer)'}`);
log(`   "reorder, don't filter" invariant held on every query: ${summary.invariantHolds ? 'yes' : 'NO — see warnings above'}`);

// ── results (merge-on-rerun, keyed by queryId — see run.mjs) ──────────────

const resultsDir = path.join(pkgRoot, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, 'codebase-rank-eval.json');
const ranKeys = new Set(records.map((r) => r.queryId));
let merged = records;
if (fs.existsSync(jsonPath)) {
  const prior = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  merged = [...prior.filter((r) => !ranKeys.has(r.queryId)), ...records];
}
fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2));

let md = `# Codebase-ranking A/B eval\n\nRun: ${new Date().toISOString()} · fixture: fixtures/codebase-corpus · ripgrep: real binary\n\n`;
md += `| query | mode | baseline rank | ranked rank | recall@5 (base/ranked) | reorder-not-filter invariant |\n|---|---|---|---|---|---|\n`;
for (const r of merged) {
  const invariantCell = r.truncated ? '— (truncated, N/A)' : r.invariantHolds ? '✅' : '❌ BUG';
  md += `| ${r.query} | ${r.outputMode} | ${r.baseline.rank ?? '—'} | ${r.ranked.rank ?? '—'} | ${r.baseline.recallAt5 ? '✅' : '❌'} / ${r.ranked.recallAt5 ? '✅' : '❌'} | ${invariantCell} |\n`;
}
md += `\n## Summary (this run)\n\n`;
md += `- baseline — MRR ${summary.baseline.mrr.toFixed(2)}, recall@5 ${summary.baseline.recallAt5.toFixed(2)}, recall@10 ${summary.baseline.recallAt10.toFixed(2)}\n`;
md += `- ranked — MRR ${summary.ranked.mrr.toFixed(2)}, recall@5 ${summary.ranked.recallAt5.toFixed(2)}, recall@10 ${summary.ranked.recallAt10.toFixed(2)}\n`;
md += `- mean rank delta (ranked − baseline, negative = improvement): ${summary.meanRankDelta ?? 'n/a'}\n`;
fs.writeFileSync(path.join(resultsDir, 'codebase-rank-eval.md'), md);

log(`\nreport → results/codebase-rank-eval.json, results/codebase-rank-eval.md`);
process.exit(summary.invariantHolds ? 0 : 1);
