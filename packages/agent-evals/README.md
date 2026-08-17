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
