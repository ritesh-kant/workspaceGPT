# Findings: why agent scenarios s2 and s3 fail 80% of the time

Handoff doc from the benchmark baseline run of 2026-08-21. Everything below is
derived from `results/agent-smoke.json` (5 runs × s1–s3 on
`qwen2.5-coder:14b-ctx24k` via Ollama) plus code reads of the worker and write
tools. Findings are marked **[confirmed]** (backed by run data or a direct code
read) or **[inferred]** (consistent with the logs, not yet proven).

## Baseline numbers

| scenario | pass rate | median wall | median turns | median tool calls |
|---|---|---|---|---|
| s1 read-only exploration | **100%** (5/5) | 77s | 5 | 15 |
| s2 multi-file rename | **20%** (1/5) | 179s | 8 | 29 |
| s3 fix failing test | **20%** (1/5) | 170s | 8 | 28 |

Wall-clock is dominated by model inference, not tooling: every read-only tool
runs at a 0–1ms median; only `run_command` (652ms) and `get_diagnostics` (91ms)
are non-trivial.

## Root cause: `edit_file` exact-string matching

**[confirmed]** Per-tool error rates across all 15 runs:

| tool | calls | errors | error rate |
|---|---|---|---|
| **edit_file** | **32** | **21** | **66%** |
| read_file | 25 | 1 | 4% |
| search_codebase | 169 | 0 | 0% |
| find_files | 70 | 0 | 0% |
| find_symbol | 39 | 0 | 0% |
| run_command | 24 | 0 | 0% |
| get_diagnostics | 11 | 0 | 0% |
| find_references | 7 | 0 | 0% |

`edit_file` is the only tool the model cannot drive reliably, and its failures
predict scenario failure almost perfectly. The two passing edit-scenario runs
had 0 and 1 failed calls; all seven edit-mechanics failures had 2–9.

**The mechanism.** The fixture defines multi-line functions:

```js
function add(a, b) {
  return a + b;
}
```

The model reads the file with `read_file`, then submits a **whitespace-collapsed
one-liner** as `oldString`:

```
edit_file {"path":"src/math.js","oldString":"function add(a, b) { return a + b; }", ...}
  TOOL ERROR: oldString was not found in the file. It must match the current file content EXACTLY...
```

It reformats source as it copies. This is the direct cause of 7 of the 8 s2/s3
failures. In s3 it is the *entire* failure: the model finds the `multiply` bug
correctly (`return a + b` should be `a * b`), then can never land the edit, so
the only failing check is `test now passes`.

### Two aggravating bugs in the recovery path

1. **[confirmed] The repeated-failing-call guard never fires for this model.**
   `modelWorker.ts:1098` builds the dedup key from the model's raw argument
   string:
   ```ts
   const callKey = `${tc.name}:${tc.args}`;
   ```
   The model re-emits the same semantic call with **reordered JSON keys**, so
   the key differs and the guard at line 1100 is bypassed. Straight from the log:
   ```
   edit_file {"path":"src/app.js","oldString":"...","newString":"..."}
   edit_file {"newString":"...","oldString":"...","path":"src/app.js"}
   ```
   Four identical-in-meaning failing edits ran back-to-back where the guard
   should have stopped the second. Fix: key on canonicalized args (parse, sort
   keys, re-stringify) — `parsedArgs` is already available two lines above.

2. **[confirmed] The `closestSnippet` hint exists but the model can't act on
   it.** `agentWriteTools.ts:120` already locates the nearest region and the
   error appends *"The closest matching region of the actual file is: ```…```
   Copy oldString EXACTLY from this"*. The model still resubmits the collapsed
   form. A hint the model reliably ignores is not a recovery path.

## Secondary failure mode: phantom changes

**[confirmed]** s2 run 2 failed differently: `writes=0`, `failedToolCalls=0`,
`phantomChanges=1`. The model described the rename without ever calling an edit
tool, got the phantom-changes nudge, and still finished with nothing written. So
~1 in 5 edit-task failures is "never attempted", not "attempt rejected". Any fix
targeting only string matching leaves this one.

## Efficiency finding: the prompt-word search storm

**[confirmed]** Independent of pass/fail, the agent burns most of its tool
budget searching for words lifted from the prompt. From s3:

```
search_codebase "Running" / "node" / "currently" / "fails" / "read" /
                "until" / "passes" / "find" / "failure" / "project"
find_files "**/*Running*" / "**/*currently*" / "**/*fails*"
```

s2 does the same with `"across"`, `"change"`, `"definition"`, `"Rename"`, and
even `find_symbol "get_diagnostics"` — searching the codebase for the name of a
tool it was told to call. That is 169 `search_codebase` + 70 `find_files` + 39
`find_symbol` calls across 15 runs on a 4-file fixture. These cost ~0ms of
wall-clock but every result enters the context, which is why s2/s3 run at
~36k median prompt tokens versus s1's ~20k. Tasks needing ~4 tool calls take a
median of 28–29.

**[inferred]** The tokenizer/stopword list in `codebaseTools.ts` (`tokenize`,
lines 152–161, drops <3 chars + 24 stopwords) is too permissive for
prompt-derived queries — words like "currently", "running", "until" survive it.

## Eval-design problems (fix these before trusting the numbers)

**[confirmed] `s2` has two checks that don't check what they claim:**

- `['app.js updated and still runs', appRun.code === 0]` — `node src/app.js`
  exits 0 when app.js was **never touched**, since `add` still exists. This
  check passes on total inaction. It should assert `/sum\(/.test(app) &&
  appRun.code === 0`.
- `['test.js import updated', /sum/.test(test)]` — a bare substring test that
  passes on a partial or wrong edit.

**Missing failure attribution.** `run.mjs` already has the right idea with its
`parse_fail | apply_fail | check_fail` taxonomy; `agent-smoke.mjs` collapses
everything into pass/fail, so "edit mechanics broke" and "model did the wrong
thing" are indistinguishable in the report. The data to separate them is already
stored per run (`metrics.failedToolCalls`, `toolTimings[].error`) — it just
isn't surfaced. **Adding an error-rate column to the per-tool latency table in
`agent-smoke.md` would have made this whole diagnosis a single glance.**

## Recommendations, ranked by expected pass-rate impact

**Product changes** (these help real users, not just the benchmark):

1. **Whitespace-tolerant `oldString` matching in `edit_file`.** On exact-match
   failure, retry with a whitespace-normalized comparison (collapse runs of
   whitespace/newlines on both sides); apply only if the normalized match is
   **unique**, else keep today's error. This is what Aider and Claude Code do,
   and it addresses the cause of 7 of 8 failures. Highest impact by a wide
   margin. `agentWriteTools.ts` around lines 187–216.
2. **Canonicalize the dedup key** (`modelWorker.ts:1098`) so key reordering
   can't bypass the repeated-failure guard. Two-line fix.
3. **Curb the prompt-word search storm** — extend the stopword list, and/or have
   `search_codebase` return an explicit hint when a query looks like prose
   rather than an identifier. Cuts tokens and turns on every task.
4. **Empty/garbage final answers.** s2 run 5 ended with `(empty response)` and
   s3 run 5 answered with the literal text ``` read_file src/math.js ```. The
   forced-final-answer path (`modelWorker.ts` ~1045/1056) should not be able to
   emit an empty or tool-call-shaped answer.

**Eval changes:**

5. Fix the two weak s2 checks above.
6. Add per-tool error-rate to the report, and a failure-attribution field
   (`edit_mechanics | wrong_edit | never_attempted | timeout`) per run.
7. Consider a fixture variant with single-line function bodies as a control — it
   would isolate "model can't copy whitespace" from "model doesn't understand the
   task". Cheap and highly diagnostic.

**Expected outcome:** if items 1–2 land, s3 should go from 20% to near s1-level
reliability (the model already diagnoses that bug correctly every run), and s2
should improve substantially but stay imperfect because of the phantom-changes
mode. The qwen-14B ceiling documented previously is real, but **it is not the
binding constraint here** — tool ergonomics are.

## Practical notes for re-running

- **Model is not hardcoded**, only defaulted:
  `--model <name>` (default `qwen2.5-coder:14b-ctx24k`), `--scenarios s1,s2,s3`,
  `--runs N`, `--timeout-min T`.
  ```bash
  node src/headless/agent-smoke.mjs --model qwen2.5-coder:7b --scenarios s2,s3 --runs 5
  ```
  **Caveat:** `provider: 'Ollama'` and `apiKey: 'DUMMY_API_KEY'` *are* hardcoded
  in the `workerData` block (`agent-smoke.mjs:271–272`). Any Ollama model works
  today; testing a remote provider needs `--provider`/`--api-key` threaded
  through. This matters because `isLocalProvider` gates `MAX_TOOL_ITERATIONS`
  (10 local vs 25 remote) and the tool-output budgets — so provider changes move
  the numbers independently of model quality.
- **Everything is stored**, gitignored and local-only:
  `results/agent-smoke.json` holds one record per run
  (`{model, scenario, runIndex, pass, checks, error, wallMs, metrics,
  toolTimings, toolCalls, answerHead}`), merged on re-run keyed `model|scenario`,
  so re-running a subset replaces only those rows. `results/agent-smoke.md` is
  regenerated from it. Real (non-benchmark) chats log the same metrics payload
  via `[agent-metrics]` in `chatService.ts`.
- Re-running a subset to test a fix: `--scenarios s3 --runs 5` replaces only the
  s3 rows, so the s1/s2 baseline stays intact for comparison.
- Rebuild the worker after any `modelWorker.ts` change or metrics go stale:
  ```bash
  cd apps/vscode-extensions && node esbuild.config.js
  ```
  (`agent-smoke.mjs` warns on a stale bundle but does not block.)
