# agent-evals

Phase 0.1 of [PHASES.md](../../PHASES.md): decide the agent's **edit format**
by testing three candidates against real edits on snapshotted files from this
repo. Also the seed of the G3 eval harness (grow to ~50 tasks by Phase 4).

## The three formats

| id | Shape | Expected failure mode |
|---|---|---|
| `search-replace` | Aider-style SEARCH/REPLACE blocks, exact+unique match | search text not copied exactly / not unique |
| `unified-diff` | fenced unified diff, context-matched (line numbers ignored) | fabricated context lines |
| `full-file` | complete file rewrite per changed file | truncation/elision on big files; token cost |

## Run

```bash
# harness sanity check — no API calls
node src/run.mjs --selftest

# the real matrix (10 tasks × 3 formats per model)
GEMINI_API_KEY=xxx node src/run.mjs
# optionally add ANTHROPIC_API_KEY for the claude row

# multiple keys, comma-separated — rotates to the next key on 429/5xx instead
# of stalling the whole run (only sleeps once every key in the ring is rate-limited)
GEMINI_API_KEY=key1,key2,key3 node src/run.mjs

# subsets
node src/run.mjs --models gemini-2.5-flash --formats search-replace --tasks rename-fn,json-edit
```

Output: `results/results.json` + `results/report.md` (pass rate, apply rate,
avg output tokens, latency — per model × format, plus a failure list).

## Reading the result

Pick the format with the best **pass rate**; break ties with **output tokens**
(cost) — full-file will win pass-rate on small files but lose badly on
`large-file-edit` (821 lines) and on cost. `apply-ok` vs `pass` separates
"format mechanics failed" from "model did the wrong edit".

Tasks live in `src/tasks.mjs`; fixtures are snapshots (hermetic — repo drift
doesn't break evals). The `ambiguous-target` task is the discriminator for
search/replace uniqueness handling; `large-file-edit` is the full-file killer;
`multi-file-rename` tests cross-file edits.

Write the decision into CODING-AGENT-ROADMAP.md open item 1 when done.

## Benchmark suite (efficiency)

Beyond the format spike above, this package also benchmarks the extension's
efficiency-critical surfaces: the agent loop, retrieval quality, and indexing
throughput. Everything below drives the REAL built `dist/` bundles — no
mocked pipeline stages — so numbers reflect actual production code paths.

### Agent efficiency — `bench:agent`

```bash
pnpm bench:agent   # = agent-smoke.mjs --runs 5
```

Extends the P1.9 smoke harness (`src/headless/agent-smoke.mjs`) to capture,
per scenario run: turns, API calls (incl. length-retry double-calls), prompt/
completion tokens, per-tool latency, budget-exhaustion and microcompaction
counts, and nudge counts — all read from a `metrics` message the agent loop
(`modelWorker.ts`'s `runAgentLoop`) emits right before its terminal `done`/
`error` message. Chat's `chatService.ts` ignores/logs that message type; it
changes nothing about the production chat path.

Results: `results/agent-smoke.json` (merge-on-rerun, keyed
`model|provider|scenario`) + `results/agent-smoke.md` (median/min–max per
cell, plus a per-tool latency table). Use `--runs N` for repeat baselines;
local-model variance is high enough that a single run will mislead you.

**Model/provider config:** copy `.env.example` to `.env` (gitignored) to set
`WGPT_BENCH_MODEL`, `WGPT_BENCH_PROVIDER` (Ollama | OpenAI | Gemini | Groq |
Requesty | OpenRouter | NVIDIA | Custom), `WGPT_BENCH_API_KEY`
(comma-separate multiple keys for failover rotation), and
`WGPT_BENCH_BASE_URL` (Custom provider only). Precedence: CLI flag
(`--model/--provider/--api-key/--base-url`) > shell env > `.env` > default
(qwen2.5-coder:14b-ctx24k on Ollama).

**Staleness warning:** if `dist/workers/model/modelWorker.js` is older than
its source, the script warns — rebuild with
`cd apps/vscode-extensions && node esbuild.config.js` first.

### Chat-response quality + latency — `bench:chat`

```bash
pnpm bench:chat   # = chat-response-bench.mjs (all 26 queries)
node src/chat/chat-response-bench.mjs --queries q01,q14 --runs 3   # subset
```

Benchmarks the NORMAL (non-agent) chat path end-to-end — the one most users
hit: query → real `searchProcess.js` retrieval over the fixture corpus →
top-k injected as `searchResults` → real `modelWorker.js` with
`codebaseTools` disabled (the `generateWithOpenAIStream` route). Per query:

- **latency** — TTFT (worker online → first `chunk`), total ms, stream chars/s
- **correctness** — `expectedFacts` regexes from `queries.json` matched
  against the answer (facts are verbatim from the corpus pages, so a miss
  means the model dropped or mangled retrieved content)
- **groundedness** — every doc-like citation in the answer (`*.md`,
  `ADO-<id>`) must be one of the injected results; hallucinated citations
  fail the run. Answers citing nothing score `n/a`, not a pass.
- **retrieval hit** — whether the expected doc made the injected top-k at
  all, so retrieval misses aren't blamed on the model.

Exit code 1 if any fresh record errored, missed a fact, or cited an
uninjected doc. Uses the same `.env` model/provider config as `bench:agent`.
Results: `results/chat-response.json` (merge key `model|provider|queryId`) +
`results/chat-response.md`.

**LLM-as-judge (`--judge`):** grades each answer 0–2 for correctness against
the injected sources and flags claims not supported by them — catching
wrong-but-plausible synthesis the fact regexes can't. Configure the judge
via `WGPT_JUDGE_MODEL/_PROVIDER/_API_KEY` in `.env` (use a model stronger
than the one being benchmarked; it defaults to the bench model with a
self-judging warning). Judge scores are informational — they show in the
report and Problems list but never gate the exit code, since a judge is
nondeterministic and the fact/grounding checks stay the regression gate.

### Retrieval quality — `bench:retrieval`

```bash
pnpm bench:retrieval:index   # one-time (cached) embed of the fixture corpus
pnpm bench:retrieval         # = retrieval-eval.mjs --rerank
```

Drives the real `dist/workers/common/searchProcess.js` against a committed,
28-page fixture corpus (`fixtures/retrieval/corpus/*.md` — wiki-style pages
+ `ADO-<id>`-style tickets) and a hand-labeled query set
(`fixtures/retrieval/queries.json`, 26 queries: semantic + numeric
id-lookup). The index is built once via the real
`dist/workers/common/createEmbeddingForText.js` (local ONNX, fully offline)
and cached by a hash of the corpus — `build-fixture-index.mjs --rebuild`
forces a re-embed.

Reports recall@1/3/5, MRR@10, and search latency p50/p95. `--rerank` also
runs each query's raw results through the real reranker/queryPlanner/
queryClassifier pipeline (`src/utils/*.ts`, compiled headlessly via
`build-units.mjs`) to quantify what the cosine/BM25 blend in
`RETRIEVAL_THRESHOLDS` buys over raw vector search.

Results: `results/retrieval-eval.json` (merge key `stage|corpusHash`) +
`results/retrieval-eval.md`.

### Codebase-ranking A/B — `bench:codebase-rank`

```bash
pnpm bench:codebase-rank
```

A/B eval for the codebase-aware ranking added in commit `28ceeda`
(`rankTokenMatches`/`rankTokenFiles` in
`apps/vscode-extensions/src/services/codebase/codebaseTools.ts`). Drives the
real `searchCodebase` (real ripgrep, via an esbuild external-resolve plugin
in `build-units.mjs` that keeps `@vscode/ripgrep` unbundled — bundling it
breaks its own runtime binary-path resolution) against a fixture
mini-monorepo (`fixtures/codebase-corpus/`) designed so the exact-phrase
search misses and the answer file is heavily outnumbered by noise files
sharing only one of the two query tokens.

Toggles ranking off via `WGPT_DISABLE_CODEBASE_RANKING=1` — a seam added
purely for this eval; nothing in the extension itself sets it — to compare
against production behavior on the same queries. Confirmed: baseline never
finds the answer in content mode (buried past the 50-match cap) and ranks it
41st of 42 in files-with-matches mode; ranked finds it at rank 1 either way.

Results: `results/codebase-rank-eval.json` (merge key `queryId`) +
`results/codebase-rank-eval.md`.

### Indexing throughput — `bench:index`

```bash
pnpm bench:index   # = index-bench.mjs --multiply 10
```

Measures files/min, wall clock, and peak RSS for the real two-stage codebase
pipeline — `dist/workers/codebase/codebaseWorker.js` (file collection,
worker_threads) and `dist/workers/codebase/codebaseEmbeddingProcess.js`
(embedding, forked child) — over a scratch copy of the fixture corpus.
`--multiply N` replicates the fixture with unique basenames to scale up the
file count. `--docs` also benchmarks `createEmbeddingForText.js` against the
retrieval fixture corpus.

Results: `results/index-bench.json` (merge key `corpusId|multiply|stage`,
historical rows kept per corpus) + `results/index-bench.md`.

### Run everything

```bash
pnpm bench:full
```

### Requirements

- **Agent bench** needs a local Ollama with the target model pulled
  (default `qwen2.5-coder:14b-ctx24k`).
- **Retrieval / codebase-rank / indexing benches** need no network or API
  key — embedding runs fully offline via the bundled local ONNX model
  (`apps/vscode-extensions/dist/models`). They do need the extension's
  worker bundles built: `cd apps/vscode-extensions && node esbuild.config.js`.
