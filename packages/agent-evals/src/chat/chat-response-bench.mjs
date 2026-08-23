/**
 * Chat-response benchmark — measures the NORMAL (non-agent) chat path, the
 * one most users hit: question → vector retrieval → streamed answer via
 * generateWithOpenAIStream. Per labeled query it records:
 *
 *   latency     — TTFT (worker online → first chunk), total ms, stream chars/s
 *   correctness — expectedFacts present in the answer (regex, case-insensitive)
 *   groundedness — every doc-like citation in the answer (*.md / ADO-\d+)
 *                  must be one of the injected search results
 *
 * Drives the REAL dist bundles end-to-end: searchProcess.js for retrieval
 * (over the committed fixture corpus) and modelWorker.js with
 * codebaseTools disabled for generation.
 *
 * Optional: --judge adds LLM-as-judge scoring — a (preferably stronger)
 * model grades each answer 0–2 for correctness against the injected sources
 * and flags fabricated claims. Judge results are informational: they appear
 * in the report but never affect the exit code (a judge is nondeterministic;
 * the deterministic fact/grounding checks stay the regression gate).
 *
 * Run: node src/chat/chat-response-bench.mjs [--model M] [--provider P]
 *        [--queries q01,q02] [--topk 5] [--runs 1] [--timeout-min 3] [--judge]
 * Model/provider/apiKey/baseUrl also come from .env — see .env.example;
 * the judge reads WGPT_JUDGE_MODEL / _PROVIDER / _API_KEY / _BASE_URL.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fork } from 'child_process';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { loadEnv } from '../env.mjs';
import { buildFixtureIndex, EMBEDDING_DIR } from '../retrieval/build-fixture-index.mjs';
import { buildUnits } from '../headless/build-units.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(pkgRoot, '../..');
const extRoot = path.join(repoRoot, 'apps/vscode-extensions');
const WORKER_PATH = path.join(extRoot, 'dist/workers/model/modelWorker.js');
const SEARCH_PROCESS = path.join(extRoot, 'dist/workers/common/searchProcess.js');
const queriesPath = path.join(pkgRoot, 'fixtures/retrieval/queries.json');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};

loadEnv();
const MODEL = argOf('model', process.env.WGPT_BENCH_MODEL ?? 'qwen2.5-coder:14b-ctx24k');
const PROVIDER = argOf('provider', process.env.WGPT_BENCH_PROVIDER ?? 'Ollama');
const API_KEY = argOf('api-key', process.env.WGPT_BENCH_API_KEY ?? 'DUMMY_API_KEY');
const BASE_URL = argOf('base-url', process.env.WGPT_BENCH_BASE_URL);
const TOPK = parseInt(argOf('topk', '5'), 10);
const RUNS = Math.max(1, parseInt(argOf('runs', '1'), 10) || 1);
const ONLY = argOf('queries', null)?.split(',');
const QUERY_TIMEOUT_MS = Math.round(parseFloat(argOf('timeout-min', '3')) * 60 * 1000);

const WITH_JUDGE = argv.includes('--judge');
const JUDGE_MODEL = argOf('judge-model', process.env.WGPT_JUDGE_MODEL ?? MODEL);
const JUDGE_PROVIDER = argOf('judge-provider', process.env.WGPT_JUDGE_PROVIDER ?? PROVIDER);
const JUDGE_API_KEY = argOf('judge-api-key', process.env.WGPT_JUDGE_API_KEY ?? API_KEY);
const JUDGE_BASE_URL = argOf('judge-base-url', process.env.WGPT_JUDGE_BASE_URL ?? BASE_URL);

const log = (s) => console.log(s);
log(`model: ${MODEL} · provider: ${PROVIDER}${BASE_URL ? ` · baseUrl: ${BASE_URL}` : ''} · topK: ${TOPK} · runs: ${RUNS}`);
if (WITH_JUDGE) {
  log(`judge: ${JUDGE_MODEL} · provider: ${JUDGE_PROVIDER}`);
  if (JUDGE_MODEL === MODEL && JUDGE_PROVIDER === PROVIDER) {
    log('⚠️  judge is the same model being benchmarked — self-judging is weak; set WGPT_JUDGE_MODEL to a stronger model');
  }
}

for (const p of [WORKER_PATH, SEARCH_PROCESS]) {
  if (!fs.existsSync(p)) {
    console.error(`❌ ${path.relative(repoRoot, p)} does not exist — build the extension's worker bundles first:\n   cd apps/vscode-extensions && node esbuild.config.js`);
    process.exit(1);
  }
}

// ── retrieval over the fixture index (same protocol as retrieval-eval) ────

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

// ── one streamed chat turn against the real worker ─────────────────────────

function runChatTurn(prompt, searchResults) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        prompt,
        searchResults,
        modelId: MODEL,
        provider: PROVIDER,
        apiKey: API_KEY,
        ...(BASE_URL ? { baseUrl: BASE_URL } : {}),
        chatHistory: '',
        codebaseTools: { enabled: false },
      },
    });

    let t0 = Date.now(); // reset on 'online' so TTFT excludes thread boot
    let firstChunkAt = null;
    let chunkChars = 0;
    let settled = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      const tEnd = Date.now();
      resolve({
        ...outcome,
        ttftMs: firstChunkAt ? firstChunkAt - t0 : null,
        totalMs: tEnd - t0,
        streamChars: chunkChars,
        charsPerSec:
          firstChunkAt && tEnd > firstChunkAt ? Math.round((chunkChars / (tEnd - firstChunkAt)) * 1000) : null,
      });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), QUERY_TIMEOUT_MS);

    worker.once('online', () => (t0 = Date.now()));
    worker.on('message', (msg) => {
      if (msg.type === 'chunk') {
        if (!firstChunkAt) firstChunkAt = Date.now();
        chunkChars += (msg.content ?? '').length;
      } else if (msg.type === 'done') {
        finish({ ok: true, answer: msg.content ?? '' });
      } else if (msg.type === 'error') {
        finish({ ok: false, error: msg.message });
      }
    });
    worker.on('error', (e) => finish({ ok: false, error: `worker crashed: ${e.message}` }));
  });
}

// ── LLM-as-judge (optional) ────────────────────────────────────────────────

let judgeUrl = null;
if (WITH_JUDGE) {
  const outDir = await buildUnits();
  const { MODEL_PROVIDERS } = await import(path.join(outDir, 'constants.mjs'));
  const base = MODEL_PROVIDERS.find((p) => p.MODEL_PROVIDER === JUDGE_PROVIDER)?.BASE_URL || JUDGE_BASE_URL;
  if (!base) {
    console.error(`❌ no base URL for judge provider "${JUDGE_PROVIDER}" — set WGPT_JUDGE_BASE_URL`);
    process.exit(1);
  }
  judgeUrl = `${base.replace(/\/$/, '')}/chat/completions`;
}

async function judgeAnswer(query, sources, answer) {
  const context = sources
    .map((s, i) => `[doc ${i + 1}: ${s.data.fileName}]\n${s.text.slice(0, 1200)}`)
    .join('\n\n');
  const prompt =
    `You are grading an AI assistant's answer against source documents. The sources are the ONLY ground truth.\n\n` +
    `SOURCES:\n${context}\n\nQUESTION: ${query}\n\nANSWER TO GRADE:\n${answer}\n\n` +
    `Grade the answer:\n` +
    `- score 2: correct and faithful to the sources; answers the question\n` +
    `- score 1: partially correct — incomplete, vague, or minor inaccuracies\n` +
    `- score 0: wrong, misleading, or does not answer the question\n` +
    `- hallucination: true if the answer states anything factual NOT supported by the sources\n\n` +
    `Reply with ONLY a JSON object: {"score": 0|1|2, "hallucination": true|false, "reason": "<one sentence>"}`;

  try {
    const res = await fetch(judgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${JUDGE_API_KEY.split(',')[0]}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 300,
        stream: false,
      }),
    });
    if (!res.ok) return { error: `judge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const text = (await res.json()).choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return { error: `judge returned no JSON: ${text.slice(0, 120)}` };
    const v = JSON.parse(m[0]);
    if (![0, 1, 2].includes(v.score)) return { error: `judge score out of range: ${v.score}` };
    return { model: JUDGE_MODEL, score: v.score, hallucination: !!v.hallucination, reason: String(v.reason ?? '').slice(0, 300) };
  } catch (e) {
    return { error: `judge call failed: ${e.message}` };
  }
}

// ── scoring ────────────────────────────────────────────────────────────────

function scoreFacts(answer, expectedFacts = []) {
  const found = expectedFacts.filter((f) => new RegExp(f, 'i').test(answer));
  return { factsTotal: expectedFacts.length, factsFound: found.length, missingFacts: expectedFacts.filter((f) => !found.includes(f)) };
}

// A citation is grounded when the doc it names was actually in the injected
// context. Answers citing nothing get grounded=null (n/a), not a pass.
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

const runRecords = [];
for (let runIndex = 1; runIndex <= RUNS; runIndex++) {
  for (const q of queries) {
    const startedAt = new Date().toISOString();
    const results = await search(q.query, TOPK);
    const injectedFileNames = results.map((r) => r.data.fileName);
    const retrievalHit = injectedFileNames.some((f) => q.expected.includes(f) || q.expected.includes(`${f}.md`) || q.expected.includes(f.replace(/\.md$/, '')));

    const r = await runChatTurn(q.query, results);
    const answer = r.answer ?? '';
    const facts = scoreFacts(answer, q.expectedFacts);
    const grounding = scoreGroundedness(answer, injectedFileNames);
    const judge = WITH_JUDGE && r.ok ? await judgeAnswer(q.query, results, answer) : null;

    log(
      `[run ${runIndex}/${RUNS}] ${q.id} ${r.ok ? 'ok' : `ERROR(${r.error})`} · ttft ${r.ttftMs ?? '—'}ms · total ${r.totalMs}ms · ` +
        `facts ${facts.factsFound}/${facts.factsTotal} · grounded ${grounding.grounded === null ? 'n/a' : grounding.grounded}` +
        `${judge ? (judge.error ? ` · judge ERR` : ` · judge ${judge.score}/2${judge.hallucination ? ' ⚠halluc' : ''}`) : ''}` +
        `${retrievalHit ? '' : ' · ⚠ retrieval miss'}`,
    );

    runRecords.push({
      model: MODEL,
      provider: PROVIDER,
      queryId: q.id,
      query: q.query,
      kind: q.kind,
      runIndex,
      startedAt,
      ok: r.ok,
      error: r.error ?? null,
      retrievalHit,
      injectedFileNames,
      ttftMs: r.ttftMs,
      totalMs: r.totalMs,
      streamChars: r.streamChars,
      charsPerSec: r.charsPerSec,
      ...facts,
      ...grounding,
      judge,
      answerHead: answer.slice(0, 800),
    });
  }
}

child.kill();

// ── results (merge-on-rerun, keyed model|provider|queryId) ────────────────

const resultsDir = path.join(pkgRoot, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, 'chat-response.json');
const keyOf = (r) => `${r.model}|${r.provider}|${r.queryId}`;
const ranKeys = new Set(runRecords.map(keyOf));
let merged = runRecords;
if (fs.existsSync(jsonPath)) {
  const prior = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  merged = [...prior.filter((r) => !ranKeys.has(keyOf(r))), ...runRecords];
}
fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2));

// ── report ─────────────────────────────────────────────────────────────────

const median = (xs) => {
  const s = [...xs].filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const p95 = (xs) => {
  const s = [...xs].filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
};
const fmt = (v) => (v == null ? '—' : Math.round(v));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');

const groups = [...new Set(merged.map((r) => `${r.model}|${r.provider}`))];
let md = `# Chat-response benchmark\n\nRun: ${new Date().toISOString()} · path: retrieval (searchProcess.js) → non-agent streamed answer (modelWorker.js) · topK: ${TOPK}\n\n`;
const anyJudged = merged.some((r) => r.judge && !r.judge.error);
md += `| model | queries | ok | retrieval hit | facts score | grounded |${anyJudged ? ' judge avg (0–2) | judge halluc |' : ''} TTFT ms (median) | total ms (median / p95) | chars/s (median) |\n`;
md += `|---|---|---|---|---|---|${anyJudged ? '---|---|' : ''}---|---|---|\n`;
for (const g of groups) {
  const [model, provider] = g.split('|');
  const rs = merged.filter((r) => r.model === model && r.provider === provider);
  const withFacts = rs.filter((r) => r.factsTotal > 0);
  const factsScore = withFacts.length
    ? pct(withFacts.reduce((a, r) => a + r.factsFound / r.factsTotal, 0), withFacts.length)
    : '—';
  const citing = rs.filter((r) => r.grounded !== null);
  const judged = rs.filter((r) => r.judge && !r.judge.error);
  const judgeCols = anyJudged
    ? ` ${judged.length ? (judged.reduce((a, r) => a + r.judge.score, 0) / judged.length).toFixed(2) : '—'} | ${judged.length ? pct(judged.filter((r) => r.judge.hallucination).length, judged.length) : '—'} |`
    : '';
  const label = provider === 'Ollama' ? model : `${model} (${provider})`;
  md += `| ${label} | ${rs.length} | ${pct(rs.filter((r) => r.ok).length, rs.length)} | ${pct(rs.filter((r) => r.retrievalHit).length, rs.length)} | ${factsScore} | ${citing.length ? pct(citing.filter((r) => r.grounded).length, citing.length) : 'n/a'} |${judgeCols} ${fmt(median(rs.map((r) => r.ttftMs)))} | ${fmt(median(rs.map((r) => r.totalMs)))} / ${fmt(p95(rs.map((r) => r.totalMs)))} | ${fmt(median(rs.map((r) => r.charsPerSec)))} |\n`;
}
if (anyJudged) {
  const judgeModels = [...new Set(merged.filter((r) => r.judge?.model).map((r) => r.judge.model))];
  md += `\nJudge: ${judgeModels.join(', ')} — informational only, never gates the exit code.\n`;
}

const problems = merged.filter(
  (r) =>
    !r.ok ||
    (r.factsTotal > 0 && r.factsFound < r.factsTotal) ||
    r.grounded === false ||
    !r.retrievalHit ||
    (r.judge && !r.judge.error && (r.judge.score < 2 || r.judge.hallucination)) ||
    r.judge?.error,
);
if (problems.length) {
  md += `\n## Problems\n\n`;
  for (const r of problems) {
    const why = [
      !r.ok ? `error: ${r.error}` : null,
      !r.retrievalHit ? 'retrieval miss' : null,
      r.factsTotal > 0 && r.factsFound < r.factsTotal ? `missing facts: ${r.missingFacts.join(' · ')}` : null,
      r.grounded === false ? `ungrounded citations: ${r.ungrounded.join(', ')}` : null,
      r.judge && !r.judge.error && (r.judge.score < 2 || r.judge.hallucination)
        ? `judge ${r.judge.score}/2${r.judge.hallucination ? ', hallucination' : ''}: ${r.judge.reason}`
        : null,
      r.judge?.error ? r.judge.error : null,
    ].filter(Boolean);
    md += `- **${r.model} × ${r.queryId} (run ${r.runIndex})** "${r.query}" — ${why.join('; ')}\n`;
  }
}
fs.writeFileSync(path.join(resultsDir, 'chat-response.md'), md);
log(`\nreport → results/chat-response.json, results/chat-response.md`);

// pass = every fresh record ok + all facts found + no ungrounded citations
process.exit(runRecords.every((r) => r.ok && r.factsFound === r.factsTotal && r.grounded !== false) ? 0 : 1);
