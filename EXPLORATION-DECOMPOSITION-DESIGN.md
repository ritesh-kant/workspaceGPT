# Exploration Decomposition — Design

**Status:** design only, not implemented
**Goal:** answer "understand the codebase" questions using *fewer* total tokens
and a cleaner main-loop context, by moving bulk file reading out of the agent
loop into disposable single-shot "explorer" completions. Decomposition here is
**deterministic (code, not model)** — same philosophy as SKILLS-DESIGN.md: the
model only answers, never plans the split.

---

## 1. Why the current loop is the expensive option

`runAgentLoop` (apps/vscode-extensions/src/workers/model/modelWorker.ts) is a
single conversation that re-sends the whole `messages` array every iteration.
That has three compounding costs:

1. **Every tool result is re-billed on every subsequent round.** A 10k-char
   `read_file` result at round 2 of a 10-round run is processed ~8 more times.
   Prefix caching softens this on some providers, but any rewrite
   (microcompaction) invalidates the cached prefix from that point on.
2. **`TOOL_DEFS` rides along on every turn.** 18 tool schemas ≈ 4–5k tokens of
   input, paid per round, even on rounds that only read files.
3. **The defenses are damage control, not prevention.** `MAX_TOTAL_TOOL_CHARS`
   (48k local / 200k remote), microcompaction at 70% pressure, and the
   budget-exhausted forced answer all exist because exploration junk
   accumulates in the one context. On large-monorepo questions the local
   budget dies in 2–3 reads (see the comment at modelWorker.ts:329).

The fix is not to make the model read less — it genuinely needs to see the
code. The fix is to make the bulk reads happen in contexts that are **paid for
once and thrown away**, so the main loop only ever carries conclusions.

### Token math (typical "how does feature X work", ~20 relevant files)

|                                   | Monolithic (today)                      | Decomposed                              |
| --------------------------------- | --------------------------------------- | ---------------------------------------- |
| Bulk file content                 | ~40k chars in `messages`, re-sent every round, compaction churn | ~4 × 16k chars, each processed **once**, never enters `messages` |
| Tool schemas                      | every round                              | main-loop rounds only (explorers carry none) |
| What the main loop carries        | truncated reads + compaction stubs       | ~4k-char claim table                     |
| Budget-exhaustion forced answer   | common on monorepos                      | should be rare                           |

Total input tokens processed end-to-end comes out *lower*, and the main loop
starts its reasoning with clean, structured context instead of raw dumps.

---

## 2. Pipeline overview

A pre-loop phase in the model worker, before the first `runToolTurn`:

```
user prompt
   │
   ▼
[1] SCOUT      code extracts terms → search/find tools, files_with_matches only   (0 model tokens)
   │
   ▼
[2] GATE       few hits / one cluster? → skip, run today's loop unchanged          (0 model tokens)
   │
   ▼
[3] CLUSTER    group hit files by package/app directory, cap explorer count       (0 model tokens)
   │
   ▼
[4] EXPLORE    per cluster: code packs file content → ONE completion, no tools    (paid once, discarded)
   │
   ▼
[5] VALIDATE   drop claims citing files/lines not in the pack                     (0 model tokens)
   │
   ▼
[6] MERGE      mechanical concat + dedupe → one claim table                       (0 model tokens)
   │
   ▼
[7] INJECT     claim table as a synthetic tool exchange → runAgentLoop starts
```

Only step 4 spends model tokens. There is **no planner call** (a weak model
mis-decomposes) and **no synthesizer call** (the main loop's first turn *is*
the synthesis — it was going to happen anyway, and merging is the step
14B-class models are worst at).

The worker can drive tools itself without a model turn: the auto-diagnostics
path (modelWorker.ts:813) already fabricates a tool exchange and calls
`requestTool` directly. Scout and the pack-building reads reuse exactly that
mechanism.

---

## 3. Scout — find where the answer lives, for free

Extract search terms from the user prompt **in code**:

- code-shaped tokens: `CamelCase`, `snake_case`, `dotted.paths`, quoted
  strings, things that look like filenames (`*.ts`, `foo/bar`);
- remaining informative words (stopword-filtered), pairwise-joined for
  phrase queries.

Then fire cheap, list-only lookups concurrently (reads already run under
`Promise.all` in the main loop; same here):

- `search_codebase` with `outputMode: 'files_with_matches'` per term;
- `find_symbol` per code-shaped token;
- `find_files` with `**/*<Term>*` for terms that got zero content hits.

Output: `Map<filePath, hitCount>`. No file content is fetched yet. Cost: a few
main-thread round trips, zero tokens.

If the prompt names a ticket (`search_tickets` trigger patterns) the ticket
text can be scouted the same way — the extracted terms just come from the
ticket body too. Out of scope for v1.

## 4. Gate — most turns should not decompose

Decomposition triggers only when **all** hold:

| Condition | Rationale |
| --- | --- |
| `codebaseTools.enabled` | phase is meaningless otherwise |
| distinct hit files ≥ `GATE_MIN_FILES` (default 6) | small spread → inline reads are cheaper than any explorer |
| hits span ≥ 2 clusters (§5) | one cluster = one explorer = no decomposition benefit; just let the loop read |
| estimated pack size > `COMPACT_PRESSURE_THRESHOLD` equivalent | if the whole thing fits comfortably in today's budget, today's loop is fine |
| prompt is not a narrow edit command | "rename X in api.ts" already names its target; scouting still helps the loop but explorers add nothing |

Gate says no → fall through to `runAgentLoop` **unchanged**. (Cheap follow-up
win, independent of explorers: inject the scout's file list as a small
synthetic tool result anyway — the loop then starts knowing where to look,
saving 1–2 discovery rounds.)

## 5. Cluster — deterministic, structural

Group hit files by their top-most meaningful path segment — for a monorepo,
the package/app root (`apps/vscode-extensions`, `apps/chrome-extension`, …);
within one package, the first source-level directory (`src/workers`,
`webview/src`). Then:

- merge clusters with < 2 files into their nearest sibling (or a `misc`
  cluster);
- rank clusters by summed hit count;
- keep the top `MAX_EXPLORERS` (local: 3, remote: 6), fold the tail into the
  claim table as a plain "also matched, unexplored: …" file list so nothing
  silently disappears.

Each cluster becomes one sub-question, phrased by template, not by a model:

> "Regarding: `<user prompt>` — what do the files below contribute? Report
> only facts visible in the code."

## 6. Explore — one completion per cluster, no tools, no loop

This is the entire token spend, so its shape matters most:

- **Single non-streaming completion** via the existing OpenAI client +
  `withKeyFailover`. **No `tools` parameter** — an explorer cannot call
  anything, so it never loops, never wanders, and never pays the 4–5k-token
  schema tax. This also sidesteps the weak-model tool-calling failure modes
  the main loop needs `extractTextToolCalls` and the nudge battery for.
- **Code builds the pack**: for each file in the cluster, `requestTool`
  `read_file` — whole file if small, else hit lines ± 40 lines of context —
  concatenated with `=== path (lines a–b) ===` separators, up to
  `EXPLORER_INPUT_CHARS` (local: 16k, remote: 48k). Files are packed in
  hit-count order; whatever doesn't fit is listed by name under "not included".
- **Prompt layout is prefix-cache friendly**: `[fixed system preamble +
  output contract] + [sub-question] + [pack]`. The preamble is byte-identical
  across all explorers and across runs, so llama.cpp / vLLM / Ollama (0.5+)
  prefix caching makes explorer N's marginal prompt cost ≈ its pack only.
  `repoOrientation` and `workspaceRules` are **excluded** — explorers answer
  about code in front of them; orientation is main-loop context.
- `temperature: 0`, `max_tokens: 600`. An explorer that wants to write more
  is producing prose, not claims.
- **Sequential on local providers** (Ollama serializes anyway; sequential also
  maximizes prefix-cache hits), `Promise.all` on remote.

### Output contract

```jsonc
{
  "claims":      [{ "fact": "string, ≤ 200 chars", "file": "path", "lines": "12-40" }],
  "entryPoints": [{ "symbol": "string", "file": "path", "line": 12 }],
  "unknowns":    ["string — questions this cluster raises but can't answer"]
}
```

Parsing reuses `extractBalancedJsonObjects` (modelWorker.ts:363) — it already
handles fences, tags, and concatenated blobs from local models.

## 7. Validate — code-checked grounding

For every claim: the cited `file` must be one the pack actually included, and
`lines` must fall inside a packed range. Violations are dropped, counted, and
logged. This is the anti-hallucination story: an explorer can only assert
things about code it was shown, and every surviving claim carries a citation
the main loop (and the UI, via the existing inline-citation rendering) can
open with `read_file(path, startLine, endLine)`.

Failure ladder per explorer: JSON unparseable → salvage raw text, truncated to
800 chars, as a single uncited "note" claim. Completion errors → the cluster's
file list goes into the merged table as unexplored. **All** explorers fail →
abandon the phase, run today's loop unchanged. The phase can degrade but can
never make a run worse than the status quo. Whole phase wall-clock cap:
`EXPLORE_PHASE_TIMEOUT_SEC` (default 60) — on expiry, use whatever finished.

## 8. Merge and inject — mechanical, then straight into today's loop

Merge in code: concatenate claim tables, dedupe (same file + overlapping
lines + near-identical fact), group by cluster, render as compact markdown,
hard cap ~4,000 chars. Append `entryPoints`, `unknowns`, and the unexplored
lists.

Inject as a synthetic tool exchange at the top of `messages`, exactly like
auto-diagnostics does:

```
assistant: tool_calls: [{ name: "explore_codebase", arguments: { question } }]
tool:      <merged claim table>
           "These are cited leads from a preliminary scan, not verified truth.
            Open any cited range with read_file before relying on it for an edit.
            Unknowns and unexplored files are listed — investigate them with
            tools if the question requires it."
```

Why a tool exchange and not part of the initial prompt: it keeps
`createStructuredPrompt` untouched, it renders in the existing step timeline
for free, and the framing ("a tool told me") measurably beats "trust this
preamble" for keeping small models grounded.

The table is recorded via `recordToolResult` and counted against
`toolCharsUsed` like any other result (it's ~4k of 48k) — but marked
never-compactable, alongside `KEEP_RECENT_ROUNDS`: it is the map for the whole
run. From here, today's loop runs completely unchanged — every existing
defense (nudges, verification discipline, failed-call short-circuit,
microcompaction for mid-loop reads) still applies; microcompaction just
becomes the fallback instead of the main defense.

---

## 9. What this is *not*

- **Not parallel agents.** Explorers may run sequentially; the win is
  context *disposal*, not concurrency. (Remote providers get concurrency as a
  free latency bonus.)
- **Not Cursor-style best-of-N.** No redundant attempts, no judge — that
  pattern multiplies token cost and needs a frontier judge.
- **Not a planner/synthesizer hierarchy.** Zero model calls for decomposition
  or merging; those are exactly the calls a 14B model fumbles.

## 10. Implementation shape

New module `apps/vscode-extensions/src/workers/model/explorationPhase.ts`:

```ts
interface ExplorationResult {
  claimTableMarkdown: string;   // "" when gate said no / phase abandoned
  stats: { explorers: number; filesPacked: number; claimsKept: number;
           claimsDropped: number; charsIn: number; charsOut: number };
}

runExplorationPhase(
  userPrompt: string,
  deps: { requestTool; runCompletion /* thin wrapper over the OpenAI client */ },
  cfg: ExplorationConfig,
): Promise<ExplorationResult>
```

`runAgentLoop` gains ~15 lines at the top: call the phase, and if
`claimTableMarkdown` is non-empty, push the synthetic exchange before the
first iteration. UI: emit the existing `tool_status` event per explorer
("Exploring apps/vscode-extensions…") so the step timeline shows progress
during the phase; stats ride on the final `done` message for debugging.

Config (constants next to the existing budget constants, same
local/remote split):

```ts
GATE_MIN_FILES = 6
MAX_EXPLORERS            = isLocalProvider ? 3 : 6
EXPLORER_INPUT_CHARS     = isLocalProvider ? 16_000 : 48_000
EXPLORER_MAX_TOKENS      = 600
CLAIM_TABLE_MAX_CHARS    = 4_000
EXPLORE_PHASE_TIMEOUT_SEC = 60
```

### Rollout

1. **P1 — scout + gate only.** Inject the scout's file list as a synthetic
   result; no explorers. Low risk, measurable on its own (rounds-to-first-
   useful-read should drop).
2. **P2 — explorers** behind a setting (`workspacegpt.exploration.enabled`),
   local provider first — it has the most to gain and the tightest budgets.
3. **P3 — tune** gate thresholds and pack sizes against the P1.9 validation
   suite; compare toolCharsUsed at answer time, forced-answer rate, and
   end-to-end tokens vs. baseline.

### Metrics that decide success

- total tokens processed per run (explorers included) vs. baseline — must be ≤;
- `budgetExhausted` forced-answer rate on monorepo questions — must drop;
- rounds-to-answer and compaction events — should drop;
- answer completeness on the P1.9 eval set — must not regress.

## 11. Open questions

- **Line-range packs vs. whole files** for the local 16k budget: hit ± 40
  lines can split a function mid-body. May need symbol-aware expansion via
  `find_symbol` ranges. Start dumb, measure.
- **Explorer model = main model?** v1: yes (one Ollama slot, shared prefix
  cache). Later: a smaller/faster explorer model is a natural extension —
  claims are code-grounded and validated, so the quality bar per explorer is
  lower than for the main loop.
- **Confluence/ADO in the same phase?** `search_docs` / `search_tickets`
  results could feed one extra "org context" explorer. Deferred — code
  clustering doesn't apply to prose, and the retrieval side already ranks.
- **Follow-up turns**: chat history means a follow-up question may already be
  covered by the previous claim table. v1 re-runs the phase (gate usually
  says no because the loop now asks narrow questions); caching scout results
  per session is a cheap later win.
