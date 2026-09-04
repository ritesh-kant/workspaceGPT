# Agent parity: making the WorkspaceGPT loop solve problems the way Claude Code does

Status: P1-P7 all implemented 2026-09-03. Section 8 records what is verified and what a live run still has to settle. Written
after comparing a Claude Code run and a WorkspaceGPT run on the same ticket
(#1534774). Section 6 tracks what has shipped, section 7 how it was verified.

## 1. Why this document exists

The two runs are a controlled experiment: same repo, same bug, same starting
prompt shape. Claude Code shipped a verified four-file fix. WorkspaceGPT
delivered "🚫 Blocked" after 57 tool calls and 0 writes. The saved WorkspaceGPT
run (`globalStorage/…/chats/2580d5fd-….json`) shows the model **found the same
root cause** at step 50 and wrote "Now I have a complete understanding. The fix
needs to clear the storage data…" at step 74. It then kept reading until the
step cap and was dumped into a gate-free final turn, where it recast the cap
hit as a product blocker.

So the gap is not "the model could not find the bug". It is **what the harness
does with a model that has found the bug**. That is a harness design problem
and it generalises to every unseen ticket, which is why the fix cannot be
another regex.

## 2. How Claude Code actually solves a problem

Six operating properties. Each one is a design choice, not a model property,
and each one was visible in the Claude Code trace on #1534774.

### 2.1 Thin harness, strong norms
Claude Code's harness enforces almost nothing about *phrasing*. It enforces a
handful of **structural invariants** (read a file before editing it, run
commands through a permission system, one final message the user can act on)
and hands everything else to the model as **principles**:

- "When you have enough information to act, act. Do not re-derive facts already established."
- "Finish the whole task, not just the easy parts."
- "If you find a real problem with the task as specified, state the concern in a sentence or two, then keep building under stated assumptions."
- "Reserve blocking questions for cases where proceeding under any assumption would be unsafe or would make the work useless."
- "Report outcomes faithfully: if tests fail, say so."

The model self-regulates against those. There is no regex for "is this
answer a stall"; the prompt makes stalling the wrong move and the model, being
capable, does not do it.

WorkspaceGPT does the opposite. `promptTemplates.ts` carries ~24 KB of prompt
text (~6k tokens), most of it prohibitions about how the *final answer* may be
phrased, and `modelWorker.ts` carries fifteen-odd phrase gates (ambiguity,
permission-seeking, plan-instead-of-execute, incomplete answer, phantom
changes, missing-tool claim, all-errors, reflection, …). Every gate was added
in response to one observed qwen failure, its own comments say so, and each
one that fires costs a turn against the cap. The prompt tells the model at
length what not to say and almost nothing about **when to stop reading and
start editing**. Worse, the autonomous block (`promptTemplates.ts:302`) says
*"a clear 'blocked on X' report is a successful outcome; guessing is not"*.
That sentence is the exact inverse of Claude Code's norm and it is what the
model quoted back on #1534774.

### 2.2 Context hygiene by delegation
Claude Code's first move on #1534774 was to spawn an Explore subagent with a
question, not a grep. The subagent read the excerpts, and **only its
conclusion** came back into the main context. The main agent then verified the
conclusion by reading the four files that mattered. Its context stayed a
reasoning space; the file dumps lived and died in the subagent.

WorkspaceGPT's exploration phase (`explorationPhase.ts`) is a deterministic
scout that runs **once, before the loop**, with tool-less explorers. The model
cannot call it. Every later read goes into the main `messages` array and is
re-sent every turn. On #1534774 the run reached 65% of a 400k-char tool
budget (≈260k chars ≈ 65k tokens of tool output) with compaction never
firing (threshold is 70%). By step 74 the model was reasoning over a
transcript that was mostly file contents. That is the mechanism behind
"kept reading instead of editing": a bloated context makes the next read
feel cheaper than committing.

### 2.3 Tools that return what was asked, once
Claude Code's Read returns up to 2000 numbered lines with offset/limit. Grep
respects `.gitignore`. One call, one answer. WorkspaceGPT's `read_file` caps
at 400 lines / 20 KB (`codebaseTools.ts:97`), so a 749-line and a 981-line
file each needed two reads, and the two key files were read three times each.
`searchCodebase` via ripgrep passes no exclude globs, so the model's own note
at step 11 reads "results are mostly `.turbo/cache` files" and five searches
were spent discovering that.

### 2.4 No cliff
Claude Code has no hard turn cap. When context fills, it compacts and keeps
going; progress is preserved, the model never loses its tools mid-thought.
WorkspaceGPT has `MAX_TOOL_ITERATIONS` (33 on a ticket run) and, at the cap,
a **forced no-tools answer** (`modelWorker.ts:2611`) that runs **outside every
gate**. The diagnostics line on #1534774 says "nudges fired: none" because the
model never attempted an answer inside the loop; its only answer was the
forced one. And because that answer was headed "Blocked", `TICKET_TERMINAL_RE`
classified it as a legitimate ending, `lastAnswerStallShaped` stayed false,
and the autonomous auto-resume in `chatService.ts:1114` did not fire. "Blocked"
is a self-certified exit that also disables the safety net.

### 2.5 Verification is part of "done"
Claude Code's trace goes root cause → edit → `tsc --noEmit` → `eslint` →
`git diff` review → report. WorkspaceGPT has the same tools (`run_checks`,
`get_diagnostics`) and the same instruction. This is not a gap; it is listed
so the design does not spend effort here.

### 2.6 Blocking is the last resort
On #1534774 the ticket body was two video filenames. Claude Code inferred the
expected behaviour from the title, chose a default for the one open
implementation question (when to clear the optimistic record), and recorded
the residual edge case. WorkspaceGPT's answer listed four candidate fixes and
asked which one, which the ticket block itself calls an implementation
choice, not a blocker (`promptTemplates.ts:154`). The prompt says that in one
sentence and then rewards "Blocked" in another; the model followed the reward.

## 3. Gap table

| Property | Claude Code | WorkspaceGPT today | Where |
|---|---|---|---|
| Regulation | principles, few structural gates | ~15 phrase gates, each costs a turn | `modelWorker.ts` 1560–2340 |
| Blocked | last resort, must be unresolvable by any default | "a successful outcome" | `promptTemplates.ts:302` |
| Delegation | model spawns subagent mid-task | pre-loop scout only, not callable | `explorationPhase.ts`, `modelWorker.ts:1856` |
| Read tool | 2000 lines, numbered, offset | 400 lines / 20 KB, unnumbered | `codebaseTools.ts:97` |
| Search | gitignore-aware | no exclude globs | `codebaseTools.ts:401` |
| Budget end | compaction, continue | hard cap → gate-free forced answer | `modelWorker.ts:2611` |
| Pacing | "when you have enough, act" | none | — |
| Fabricated "done" | model norm + user sees diff | harness note only on ticket/execute runs | `modelWorker.ts:1584` |
| Auto-resume | n/a | skipped when answer is "Blocked" | `chatService.ts:1114`, `answerGates.ts` TICKET_TERMINAL_RE |

## 4. The design

Ordered by leverage. P1–P3 change what the run *does*; P4–P6 remove friction;
P7 makes the result measurable on tickets nobody has seen yet.

### P1. Rewrite the operating norms (prompt) — IMPLEMENTED 2026-09-03
Replace the ticket block's prohibition pile and the autonomous block's reward
for blocking with one short principles section, modelled on Claude Code's:

```
## HOW TO WORK
- Investigate until you can state the answer — for a bug, the root cause — in one sentence with a file:line. Then stop investigating.
- When the task is to change something, the turn after you can name the root cause your next tool call is an EDIT, not another read.
- A question a competent engineer would settle with a default is yours to settle: take it, implement it, record it under Assumptions.
- "Blocked" is for one case only: the task demands behavior no default could satisfy, and you can QUOTE the words that conflict.
- Finish the whole task: edit → get_diagnostics → run_checks → report. Say so when a check could not run.
- Never describe an edit you did not make.
- Reuse what you already have; do not re-read or re-search what is above.
```

As shipped (`promptTemplates.ts`, `HOW_TO_WORK`):
- Every bullet is **self-gating**, so one block serves a plain question, a
  fix, a ticket run and a follow-up alike. It rides on **every** codebase
  turn, not only ticket runs — the observed fabrication came from a follow-up
  question, so norms scoped to ticket runs would have missed it. Plan mode is
  the only exclusion: "your next call is an edit" contradicts its contract.
- The sentence at the old `promptTemplates.ts:302` — *"a clear 'blocked on X'
  report is a successful outcome; guessing is not"* — is gone. Its replacement
  says blocking is the last resort and that nobody watching makes a sensible
  default **more** right, not less.
- Five sentences left the ticket block (ambiguity, implementation-choice,
  assumptions, blocked-bar, permission-asking) because HOW TO WORK now states
  each once. What stayed: acceptance criteria as the definition of done, the
  three verdicts, the three valid endings with the exact `## Blocked` /
  `## No change needed` headings `TICKET_TERMINAL_RE` matches, and FINAL
  REPORT FORMAT.

**Correction to this document's original claim.** It set a target of the
assembled ticket prompt dropping "by at least a third". Measured, it did the
opposite: **+702 chars on a ticket run and +1 772 on a plain codebase turn**
(the latter previously carried no norms at all). Norms replaced prohibitions
at roughly 1:1 size, and extending them to every codebase turn costs more
than the trim saved. That is the right trade — ~175 extra tokens on a ticket
run buys the one instruction the stalled run was missing — but prompt-weight
reduction is **P5's** job (deleting gates and the prompt scaffolding they
need), not P1's, and should not be claimed here.

### P2. Pacing signal and no gate-free exit (loop) — IMPLEMENTED 2026-09-03
Two changes, both keyed on progress rather than phrasing.

**1. Commit nudge** (`commitNudgeTriggers` in `answerGates.ts`, called from the
loop). A write-intent run with zero writes gets told, mid-loop, how many turns
are left and that its next call should be an edit. Two independent triggers:

- **narration** — the round the model's own prose says it found the cause,
  matched by `ROOT_CAUSE_NARRATION_RE`.
- **budget** — once the run passes 60% of its iteration cap.

**Deviations from the original plan, all forced by the evidence:**

- The plan said one nudge per run. Shipped as **two independent one-shots**.
  With a single flag, narration firing on turn 5 would disarm the turn-20
  backstop — the one that actually catches a run reading its way to the cap.
- The plan compared `toolCallsExecuted >= 0.6 * iterationCap`. Those are
  different units: #1534774 made 57 tool calls across 34 turns against a cap
  of 33, so the comparison would have fired around turn 12 by accident. Turns
  are what run out, so the trigger uses the turn index.
- `ROOT_CAUSE_NARRATION_RE` was calibrated against all 24 prose notes of the
  real transcript, and two earlier drafts were rejected by it. A bare
  `this is (the|what causes)` matched "(this is the key flag for the rejection
  section)" at turn 5, and a bare `now i understand` matched "Now I understand
  the architecture. The flow is:" at turn 10 — both mid-investigation.
  Understanding of the CAUSE is the trigger; understanding of the
  architecture is not. The shipped pattern matches 4 of the 24 notes, and
  those four are exactly the "I found it" moments at steps 48-84.
- Held back until the third round, so an opening hypothesis cannot
  short-circuit the investigation that makes the edit correct.
- The decision is a **pure function** rather than an inline condition, because
  it decides whether a run gets its one chance to be told to commit and an
  off-by-one there would be invisible in production. Nine tests cover the
  arithmetic.

**2. Gated exit** (`isUnfinishedWriteRun`). A write-intent run that reaches the
forced no-tools answer having written nothing is reported `stallShaped: true`,
so the host resumes it once with a fresh budget and the reads already paid for.

The measurement that justified making this structural rather than another
regex — run against the real answer text:

| Gate | Result on the #1534774 cap-hit answer |
|---|---|
| `PREMATURE_AMBIGUITY_RE` | no match |
| `PERMISSION_SEEKING_RE` | no match |
| `CHANGE_PLAN_RE` | no match |
| `INCOMPLETE_ANSWER_RE` | no match |
| `CLAIMS_CHANGES_RE` | no match |
| `TICKET_TERMINAL_RE` | **match** — its "## Blocked" heading read as a legitimate ending |

So `stallShaped` was false and the host's one-shot auto-resume never fired.
Every phrase gate missed; the fact that survives any rephrasing is that the
turns ran out with an untouched tree. A `## No change needed` ending is spared
(it is finished, not interrupted); a `## Blocked` at the cap is not, which is
the entire point. The auto-resume is a single sequential call in
`chatService`, not a loop, so firing more often cannot recurse.

**Also changed, because they were part of the same failure:**

- The cap prompt no longer invites the relabelling. It now says explicitly
  that a step or budget limit is a harness limit and not grounds for
  `## Blocked`, and asks for `## ⚠️ Partially done` with the identified edit
  instead. Its old "list the specific files still unread" instruction is what
  produced that answer's paragraph of homework for the next run.
- The auto-resume prompt now tells the second segment what the first one got
  wrong: it ran out of steps rather than out of options, and `## Blocked`
  needs a conflict it can quote.
- **Write intent** (`hasWriteIntent`) is new and deliberately separate from
  `IMPLEMENT_MANDATE_RE`, which is left untouched so no existing gate changes
  behaviour. That regex is narrow by design and misses the most ordinary
  request there is: `fix the crash in foo.ts` matches none of its
  alternatives, because "crash" is not in its `bug|issue|ticket` list. Without
  a wider test, both P2 mechanisms would have covered ticket runs and approved
  plans while leaving hand-typed fix requests exactly as they were. A leading
  interrogative disqualifies a message ("how do I fix the crash?"), but polite
  imperatives do not ("can you fix the crash?" is an instruction whatever its
  punctuation). 16 prompt cases pinned in the suite.

### P3. Mid-loop delegation tool — IMPLEMENTED 2026-09-03
`explore` is now a callable tool: the model passes a `question` (plus an
optional `scope` hint), the harness runs a bounded read-only sub-loop, and the
caller gets back a short table of cited findings. The sub-agent's file
contents never enter the caller's `messages` — that is the entire point. On
#1534774 a survey costing six reads and ~40 KB of context becomes one tool
result of well under 200 characters.

It runs **inside the worker**, intercepted in the dispatch before the host
bridge, because there is no host-side tool of that name (`chatService`'s
dispatch would throw "Unknown tool"). Its own tool output is charged to its
own budget; only its API spend is folded into the run's metrics, since that
is real money whether or not the context stays clean.

Four properties are enforced in code rather than asked for in the prompt:

- **Read-only, enforced on execution.** The allowance is search/read/find/list
  plus symbol navigation. A call outside it is refused inside the sub-loop and
  never reaches the workspace — checked by a test asserting that
  `edit_file`, `run_command` and `delete_file` produce zero executed tools.
  Offering a restricted tool list is not sufficient on its own: models call
  tools they were never given.
- **Claims are validated against files it actually opened**, reusing
  `explorationPhase`'s existing parser and validator (now exported, so there
  is one claim contract rather than two). A claim citing a file it never read,
  or a line range past the end of one it did, is dropped. Delegation must not
  become a laundering channel for invented paths — this ticket already
  produced exactly that failure once, from a file that did not exist.
- **Reads do NOT enter `readPaths`.** The sub-agent read those files; the
  caller did not. An edit built from a citation alone is still an `oldString`
  from memory, so the read-before-edit guard must still fire and hand over the
  real text. Skipping this would have quietly turned a safety net off.
- **It can never fail the run.** A provider error, an empty question, a
  non-JSON answer and a spent budget each degrade to a usable report — in the
  prose case the answer is kept as an explicitly uncited note rather than
  discarded.

Bounded at 3 delegated investigations per run (2 local), 8 sub-turns each (5
local). Past the cap the tool says the budget is spent and tells the model to
read directly: a model that delegates instead of deciding is stalling by
proxy, and each sub-loop is real wall-clock.

**Also changed, because a tool nothing reaches for is worthless:** HOW TO WORK
now carries the norm ("a question that spans several files you have not read
is a job to delegate, not to read your way through"), and the tool-picking
guidance names `explore` first with its anti-use ("not for a file you already
know you need"). This is the one place P3 mirrors Claude Code most directly —
its first move on this ticket was a subagent with a question, not a grep.

**A UI gap this exposed and fixed:** steps are marked complete by the
`tool_request` handler, keyed on the request id. `explore` never issues one,
so its step would have sat at "running" for the rest of the session — which is
what the pre-loop phase's own `explore_codebase` steps already do in the saved
transcript. A `tool_step_update` message now lets the worker update and close
a step it owns, and progress updates the same step in place rather than
leaving one dangling entry per lookup.

### P4. Tool ergonomics — IMPLEMENTED 2026-09-03
**Reads.** `MAX_READ_LINES` 400 → 2000 and `MAX_READ_BYTES` 20 KB → 64 KB, so
the files at the centre of #1534774 (749 and 981 lines) come back in one call
instead of two-plus-a-re-read. A read also gets its own worker-side result cap
(`MAX_READ_RESULT_CHARS`, 72 KB remote / 16 KB local) because the shared 20 KB
cap would have truncated the larger read anyway and silently undone the
change. Searches keep the tighter cap: a wide grep is the thing that should be
narrowed, not enlarged.

**Line numbers.** Read output is now prefixed `  12→code`. The report format
demands `file.ts:L120-L130` evidence per criterion, and without numbers the
model estimates — the fabricated follow-up cited `imageReuploadStorage.ts:31-L34`
for a function that never existed. `readFile` also returns `startLine`/`endLine`
so a follow-up call can name the next slice.

This is the one change here with a real failure mode, and it needed three
supporting fixes found by tracing every consumer:

- `edit_file`'s contract is that `oldString` is copied character-for-character
  out of read output, so a copied `142→` would match nothing — and the
  existing whitespace-tolerant rescue could not save it, because digits are
  not whitespace. `applyOneEdit` now strips the prefixes deterministically
  (from `newString` too, or they would be written into the file) and reports
  that it did. Relying on a prompt instruction instead would have been the
  kind models drop on turn 25.
- `stripLineNumbers` is all-or-nothing: every non-blank line must carry a
  prefix before anything is stripped, so source containing a stray arrow, or
  a `=>`, comes through untouched. Mangling a correct `oldString` would be
  worse than the problem being solved.
- The unread-file hand-back in `modelWorker` re-reads the target and tells the
  model to copy from it verbatim, so it strips the numbering it just added.
  `@`-mentioned files go through the same `readFile`, so the mentions block
  now says the lines are numbered.

**Searches.** One shared `SEARCH_EXCLUDED_DIRS` list now drives ripgrep's
negative globs and both `findFiles` exclude parameters, and
`ORIENTATION_EXCLUDED_DIRS` derives from it so the two cannot drift. A glob
that deliberately points into an excluded directory still reaches it.

**Correction to this document's original claim.** It said `searchCodebase` via
ripgrep "passes no exclude globs, so the model's own note at step 11 reads
'results are mostly `.turbo/cache` files'". That attribution was wrong, and
measuring it against the bundled rg binary is what showed why: ripgrep skips
dot-directories by default, so it never returned `.turbo` at all. The real
source was the two `findFiles` call sites, which passed `undefined` for the
exclude parameter — that applies only the user's own
`files.exclude`/`search.exclude` settings, and those do not mention `.turbo`.
Measured before and after on a fixture:

| | files returned for one query |
|---|---|
| ripgrep, no excludes (before) | `src/a.ts`, `build/out.js`, `dist/bundle.js`, `coverage/lcov.info` |
| ripgrep, with excludes (after) | `src/a.ts` |
| ripgrep, either way | never `.turbo/cache/blob.json` — it is hidden |

So the rg fix was still worth making, for a different reason than the one
written down: `dist`, `build`, `out` and `coverage` are not hidden, and
ripgrep searches them whenever they are not gitignored.

**Also changed, because raising the read cap would otherwise have degraded
it:** exploration now asks for an explicit 400-line slice per file. Its
explorers work to a fixed character budget for breadth across a cluster, and
one 64 KB file would have consumed the whole budget and pushed the rest onto
`skipped`.

### P5. Harness profiles — IMPLEMENTED 2026-09-03
`resolveHarnessProfile` gives every run one of two harnesses, split by KIND of
check rather than by strictness.

**`strong-model` runs the structural gates only** — the ones that check state,
which no phrasing can talk its way out of: zero writes on an implement
mandate, a last write that failed, claimed changes with nothing on disk, zero
successful tool results, an empty answer, unverified writes, and P2's pacing
signal. **`small-model` adds the phrase gates** on top: premature ambiguity,
permission-seeking, plan-instead-of-execute, narrated tool plans,
incomplete-answer, the false "no write tool" claim, force-read, and the
blanket completeness reflection.

Two things are deliberately NOT gated. **Honesty**: a fabricated completion
report is caught in both profiles, because "this model is good enough to
trust" is exactly the assumption that failure violates. **Verification**:
`AutoVerifyTracker` runs the lint/typecheck/test batch itself, ahead of and
independent of the gate chain, so dropping the reflection does not weaken it.

**What it actually saves.** Up to 9 turns of a 33-turn cap can no longer go to
phrase gates (incomplete-answer and narrated-plan are worth 2 each), and the
completeness reflection — a full extra round trip on essentially every
tool-using run — is gone. That is the real cost removed; the prompt saving
below is the smaller half.

**Also implemented: the paired prompt reduction.** Three clause groups in the
tool guidance exist to counter specific 14B-class failures — a narrated tool
plan instead of a call, giving up after one search wording, and claiming the
write tools were withheld. Each is paired with the phrase gate that catches
the same failure in the answer, and the pairing is the invariant: they are
disabled *together*, because a gate with no matching instruction would punish
a model that was never told, and an instruction with no gate is pure per-turn
weight. A test asserts both halves.

Measured on the #1534774 ticket prompt:

| | chars |
|---|---|
| pre-P1 baseline | 16 172 |
| now, small-model harness | 17 498 (+1 326) |
| now, strong-model harness | 16 267 (+95) |

**Correction to the claim this document made.** Section 6 said P5 would
deliver "the prompt-weight reduction P1 could not deliver". It delivers
parity, not a reduction: a strong-model run now carries the P1 norms, the P3
delegation guidance and the P4 read/citation notes for 95 characters more than
the original prompt cost — 0.6%. Useful, and honest to call it break-even
rather than a saving.

**One gap found while building it.** Provider is not enough to classify a
model: `isLocalProvider` only detects Ollama, so a qwen-14B served through
OpenRouter would have been handed the strong-model harness and lost the gates
written for it specifically. `SMALL_MODEL_HINT_RE` matches the families
commonly run at 7B-32B, and it is deliberately generous, because the two
errors are not symmetric — calling a capable model "small" costs some turns
and prompt weight (today's shipped behaviour), while calling a weak model
"strong" removes the guardrails holding its run together. 11 resolution cases
are pinned.

An explicit `harnessProfile` in the worker payload overrides both signals.
Nothing in `chatService` sets it today and there is no user-facing setting:
it exists so P7 can run one ticket under each harness.

### P6. Fabrication stamp on every turn — IMPLEMENTED 2026-09-03
The follow-up on #1534774 ("give me the steps") produced a "✅ Done — fixed"
report with invented files, an invented regression test and "12 passed", with
`filesChanged: []`. `finalizeDeliverable` skipped the harness note because the
turn was neither a ticket-implement run nor an execute mandate nor a run that
attempted a write — all three scope conditions were false.

As shipped, the decision moved into `isUnbackedCompletionClaim`
(`answerGates.ts`), called from `finalizeDeliverable`. The three scope
conditions become **one of two ways in** rather than the only way: an answer
that heads itself `## Done` (or Fixed / Implemented / Complete) **while
claiming file changes** is checkable on its own, whatever kind of turn made
it. Two guards keep it honest in the other direction:

- **`priorWrites`** — new plumbing. `chatService` now keeps
  `run.sessionWritesApplied` (never cleared per turn) and passes it to the
  worker. Turn 1 applies the fix, turn 2 recaps it truthfully: that recap has
  zero writes of its own and must not be called a lie. Without this the stamp
  would fire on exactly the honest answer the user asked for on #1534774.
- **`planMode`** — proposing edits in prose is that mode's deliverable.

**Deviation from the original plan.** It said to widen `CLAIMS_CHANGES_RE`
with `added|extracted|rewired|wired|introduced`. Widening it wholesale would
have made "the flag was added in PR #123" a claim about the current run — the
exact false positive the old narrow scope existed to prevent. Instead:
`CLAIMS_CHANGES_RE` gained those verbs **only in its first-person group**
("I added", "I rewired"), and the report's own **`### Changes` section** became
the primary signal, since FINAL REPORT FORMAT says to omit that section when
nothing changed. It is a cleaner signal than any verb list: a fabricated
report lists its invented files exactly there.

Pinned in `packages/agent-evals/src/headless/unit-tests.mjs` against the real
answer text, together with all five false-positive cases (truthful recap,
plan mode, applied writes, verify-only "Done", Q&A about a past PR).

### P7. Measure on unseen tickets — IMPLEMENTED 2026-09-03
`node src/headless/ticket-evals.mjs` runs ticket-shaped tasks through the
**real** model worker and scores them against behavioural oracles, under each
harness profile. Four scenarios:

| scenario | shape | oracle |
|---|---|---|
| `t1` | a shared mapper whose stale optimistic record masks a second rejection, reached through four call sites of which three gate the lookup — the shape of #1534774 | the acceptance suite passes |
| `t2` | the ticket is already satisfied | zero writes **and** a "No change needed" ending |
| `t3` | the ticket's two criteria contradict | a "Blocked" ending quoting the conflict, no guessed fix |
| `f1` | the model claims a fix it never made | the harness note appears on the answer |

**Deviation from the plan, and why.** It called for 10-15 real closed ADO
tickets with their merged diffs as oracles. The ticket TEXT is available (1 437
work items are cached locally), but the repository those diffs apply to is not
on this machine, so a merged diff can be neither replayed nor checked. Fixtures
with seeded bugs give up realism and gain the one thing an eval cannot work
without: a decidable oracle. The oracles are **behavioural** — a suite encoding
the acceptance criteria goes from failing to passing — not shape-based, so a
fix the fixture author did not imagine still passes.

**The second mode, which the plan did not anticipate.** A live run needs an API
key and answers "does a real model do better". There is a second question that
matters just as much and that no live run answers cheaply: **do the mechanisms
fire at all inside the real worker?** So the runner also drives the loop
against a scripted OpenAI-compatible endpoint (`mock-model.mjs`, served to the
worker as a `Custom` provider), which is deterministic and free. It asserts
from what the model ACTUALLY RECEIVED, not from whether the run passed:

| mechanism | assertion | result |
|---|---|---|
| P1 | the operating norms reached the model | ✅ |
| P2 | "Checkpoint from the harness: N tool turn(s) left" was delivered after the narration | ✅ |
| P3 | `explore` ran a sub-loop, was offered **no** write or command tool, and returned 172 chars of findings instead of file contents | ✅ |
| P4 | an `oldString` copied WITH the `12→` prefixes still applied — the stripper fired | ✅ |
| P5 | the strong prompt omits the weak-model scaffolding; the small prompt carries it | ✅ |
| P6 | a fabricated "## Done" report was stamped, in **both** profiles | ✅ |

8/8 rows pass. The t1 script deliberately leaves the line-number prefixes on
its edits, because that is the mistake the model will make now that reads are
numbered — if the stripper regressed, t1's edits stop applying and its suite
stops passing.

**Two things building it found.**

1. **The harness's own `read_file` stub had drifted from production.** It
   returned raw text, with a comment asserting that production never numbers
   lines — true when written, false since P4. Any eval run through it would
   have tested a different read contract than the product uses, and would have
   hidden exactly the prefix-copy failure numbering introduced. Fixed to mirror
   production, caps included, using the production helper rather than a copy.
2. **The first version of t1's oracle was too weak to catch the real bug.** Its
   suite covered two of the four image types, so a run that un-gated one call
   site passed. That is precisely the half of the fix the comparison run
   missed, so the suite now covers all four.

**Metric honesty.** In mock mode "tool calls from root cause to first edit" is
determined by the script, not by a model's judgement, and the report labels it
as such. Letting a fixture artefact read as a regression would be worse than
not measuring it.

## 5. What the harness cannot fix

Claude Code ran on a Mythos-class model. The managed WorkspaceGPT model is
whatever `openrouter_model` is set to in the Worker's D1 config. A thinner
harness is a bet that the model can self-regulate; Claude Code wins that bet
with its model and WorkspaceGPT's qwen-era gates were built because a 14B
model could not. P5's profile switch is how both stay true at once. If the
managed model turns out not to hold the norms in P1, the eval in P7 will show
it as a rising fabrication or Blocked rate, and the answer is a stronger
managed model, not more regexes.

## 6. Implementation order and touchpoints

All seven shipped 2026-09-03.

1. ~~P1 + P6 — prompt norms and the honesty stamp.~~
2. ~~P2 — commit nudge and gated exit.~~
3. ~~P4 — tool caps, line numbers and search excludes.~~
4. ~~P3 — the `explore` delegation tool.~~
5. ~~P5 — harness profiles and the paired prompt reduction.~~
6. ~~P7 — the ticket eval.~~ `ticket-evals.mjs`, `ticket-fixtures.mjs`,
   `ticket-mock-scripts.mjs`, `mock-model.mjs`; `agent-smoke.mjs` now exports
   its host emulation and its `read_file` stub matches production.

## 7. Verification

| Check | Result |
|---|---|
| `packages/agent-evals` headless suite | 211 passed, 0 failed |
| `pnpm ticket-evals` (real worker, scripted model, 4 scenarios × 2 profiles) | 8/8 passed |
| `tsc --noEmit` on the extension | 3 errors, all pre-existing in `confluenceAuthService.ts`, none in the changed files |
| `node esbuild.config.js` | build succeeded |
| `eslint src --ext ts` | **not runnable** — the package has no ESLint config, so its own `lint` script fails identically on a clean tree |

## 8. What is still not known

The gap has narrowed from "none of this is verified" to something specific.
**Verified:** every mechanism fires inside the real worker, and the three
honest endings (fixed / no change needed / blocked) all survive the gate chain
in both profiles.

**Not verified — and only a `--live` run can settle it:**

1. Whether a real model, given the commit norm and the nudge, edits instead of
   reading. The scripted run proves the nudge arrives, not that it works.
2. Whether a real model reaches for `explore` unprompted, or ignores it.
3. Whether numbered reads help citation accuracy or just get copied wrong more
   often — the stripper absorbs the mistake, but a model that fights the format
   wastes turns doing it.
4. **Whether the strong-model harness helps or hurts.** Five gates were removed
   from the managed model's runs on the argument that a capable model does not
   need them. The eval shows both profiles passing the same scenarios, which
   means the removal broke nothing — not that it improved anything.

The command for all four: `WGPT_BENCH_API_KEY=... pnpm ticket-evals:live`.
Re-running the real ticket #1534774 by hand is still the most honest single
test, since the fixtures were built by the same person who built the harness.

## 9. Follow-on: surviving the provider (2026-09-04)

P1-P7 assumed the loop's own decisions were the only thing that could waste a
run. Ticket #1324128 showed otherwise: on turn 18, OpenRouter answered
`Service temporarily unavailable. All endpoints are currently overloaded.` The
model had done nothing wrong, the conversation envelope was structurally valid
(`findEnvelopeViolations` reported nothing), and the run ended anyway —
eighteen steps of investigation discarded, because the worker's `messages`
array dies with the worker.

The cause was that only HTTP 429 was retryable. `withKeyFailover` rotated keys
on a rate limit and rethrew everything else, and the OpenAI SDK's own default
of `maxRetries: 2` gives about 1.5 seconds of backoff — sized for a dropped
packet, not for a provider under load.

Three changes, all in the "deterministic beats nudging" spirit of the rest of
this document:

1. **`withKeyFailover` now separates the two failures by what they are facts
   about.** A 429 is a fact about one KEY, so it rotates. A 5xx or an
   "overloaded"/"temporarily unavailable" message is a fact about the
   PROVIDER, so it waits and retries the SAME key — rotating would burn the
   user's other keys against an outage that affects all of them. The schedule
   is `TRANSIENT_RETRY_DELAYS_MS = [5s, 15s]`, three attempts per key, and
   every wait posts a `key_failover` notice so a 20-second pause reads as a
   retry rather than a hang. 401/403/4xx still surface immediately, so a
   broken key is never masked by patience. The numeric text match is anchored
   to the start of the message on purpose: unanchored, a context-length 400
   quoting a token count would look like a 500.
2. **`maxRetries: 4` on the tool-turn client** (`MODEL_CLIENT_MAX_RETRIES`),
   which absorbs short blips so the schedule above is rarely reached. The
   plain streaming chat path deliberately keeps the SDK default — a failed
   chat turn costs the user a retry, a failed tool turn costs the whole run.
3. **Ticket screenshots are no longer sent twice.** `chatService` prefetches a
   ticket's first two images into `imageAttachments` (message 0); when the
   model then called `get_ticket`, the same images were pushed again as a
   follow-up user turn. Both copies rode in every request, on every turn.
   `sentImageDataUrls` + `unsentImages` now filter by dataUrl, so the
   un-prefetched third image still arrives and a second `get_ticket` adds
   nothing.

Verified: 191 headless tests (12 new — 10 on the retry classifier and
schedule, 4 on the images) and 8/8 ticket evals. The image tests assert on the
**request bodies the mock model actually received**, and they FAILED against
the pre-fix bundle and passed after — so they measure the fix rather than
passing vacuously.

## 10. Making the run resumable (2026-09-04)

Section 9 closed by saying a run that dies still loses its work. That was
half wrong, and the half that was right was the important half.

**What already existed.** The worker mirrors its model-facing `messages` array
to the host at every round boundary (`syncTranscript`), the host keeps it in
`SessionRun.agentTranscript`, `settle()` clears it only for a DELIVERED
answer, and `seedFromTranscript` rebuilds a run from it — repairing rounds
whose tool results never arrived, and recovering `writesApplied`, `readPaths`,
`writtenPaths` and `checksDone` so a resumed run neither redoes an edit nor
re-reads a file. So the transcript survived the 503. Three things stopped that
from being resumability:

1. **Nobody was told.** The error card said `Service temporarily unavailable.`
   and nothing else. Eighteen steps were being held and the only way to claim
   them was to happen to type a word matching `RESUME_RE`. The card now names
   how much is held and says **continue**.
2. **No automatic resume on a failure.** The existing one-shot auto-resume is
   reached only on the SUCCESS path (a stall-shaped answer); an error rejects
   straight past it to the catch. In autonomous mode nobody is present to type
   anything at all. `sendMessage` now catches the failure, waits
   `PROVIDER_RECOVERY_WAIT_MS` when the provider was the problem, and resumes
   once with a fresh worker — hence a fresh tool budget. Gated by
   `isAutoResumableFailure`: an outage, a dead socket or the stall net, but
   never a cancellation, a 401/403, an exhausted 429, or any 4xx, because
   those resume into the identical failure and only delay the real error.
3. **It lived in a `Map`.** A window reload, an extension restart or
   reopening the chat from history and the work was simply gone.
   `resumeStore.ts` parks the transcript beside the chat history — its own
   folder, because `HistoryService.getHistoryList` JSON-parses every file in
   `chats/`; age-capped at 12 hours, because a transcript describes files as
   they were; trimmed by whole ROUNDS when oversized, because an orphaned tool
   result is a 400 from every provider. Writes are debounced (4s trailing,
   with the terminal paths flushing at once) and serialized per session, so a
   delete can't land after the save that follows it.

One deliberate asymmetry: a delivered answer retires the record, but a user
who simply asks something else only drops the in-memory copy. A message that
isn't a continuation is not a decision to throw the work away.

Verified: 206 headless tests. The 15 new ones include a round trip through the
REAL worker — run a scripted agent that reads a file and edits it, capture the
transcript it mirrors, feed it back as `resumeTranscript`, and assert on the
request bodies the mock model receives that the earlier tool results arrive,
that the recovered write is reported, and that the resumed run re-investigates
nothing. Plus the interruption shape itself: a transcript truncated on an
unanswered `tool_calls` must reach the provider with every call answered.

That last test found something worth keeping: the resumed run *did* make tool
calls — three `run_checks` on the file the interrupted run had written. That is
the auto-verification tracker correctly recovering `writtenPaths` across the
resume, so the assertion now allows verification and forbids re-investigation,
which is a stronger claim than "made no calls".

### The Resume button

The affordance came next, and building it surfaced a hole in the persistence
above.

The button sends a bare `continue` through the ordinary send path, so every
host code path it touches is the already-tested one a typed "continue" takes —
it is a shortcut, not a second mechanism. The error bubble is kept rather than
replaced (unlike Retry, which removes it): the error is the record of what
interrupted the run, and the resume is an addition to the conversation.

**Why the message has to be bare.** It must satisfy TWO host patterns at once.
`RESUME_RE` decides whether the stranded transcript is carried into the turn.
`CONTINUATION_RE` is narrower — bare confirmations only — and decides that the
turn inherits the previous one's routing instead of being reclassified from
scratch. The natural phrasing, "Continue the interrupted run.", matches the
first and FAILS the second. Both patterns and the word now live together in
`continuationIntent.ts`, imported by the host and the webview, with the
invariant asserted in the suite and the tempting wording kept as a negative
test.

**The hole it exposed.** Routing inheritance read `run.lastUseCodebaseTools` —
which is `false` after a window reload, because the run object is new. So a
"continue" on a reloaded window would classify as ordinary chat,
`generateModelResponse` would pass no roots, and the resume transcript would be
silently dropped: the persistence added above would have done nothing in the
exact case it was built for. The resume decision is now settled BEFORE
classification, and a held transcript forces `CODEBASE` regardless.

Verified: 211 headless tests, and the button itself in a browser at sidebar
width against the real bundle — the card renders, the text drops the
file-changes clause when there were none, and the click posts
`{ message: 'continue', autonomous: true }` and hides the button while the run
is in flight. That preview harness is now committed at
`webview/tools/preview.mjs` rather than rebuilt from scratch a third time; it
supplies a mock `acquireVsCodeApi` plus the `--vscode-*` theme variables and
nothing else, so what renders is the real component tree against the real CSS.

### Known gap: resume does not cross windows (not fixed)

A resume is keyed by `sessionId`, which is a bare client-side `Math.random()`
UUID minted by the webview the first time a chat sends a message
(`generateSessionId`, App.tsx) — unrelated to the workspace folder. Two chats
on the same repo get two unrelated ids.

Both halves of "resumable" are keyed by that id: the in-memory
`ChatService.runs` Map, and the on-disk record in
`globalStorage/agent-resume/<sessionId>.json`. Two VS Code windows are two
separate extension host processes, each with its own `ChatMessageHandler` →
`ChatService` → empty `runs` Map, so a run dying in window A leaves window B's
process with no idea it happened — there is no shared in-memory state at all.

The disk half IS actually shared: `globalStorageUri` is scoped to the
extension per machine, not per workspace, so both windows read/write the same
`agent-resume/` folder. That only helps if window B asks for the exact same
`sessionId`, which happens only when the user opens History in B and clicks
the identical session — `handleSelectSession` reuses the stored id rather than
minting a new one, so that specific path does find window A's record. Nothing
else does.

Two consequences, one soft and one sharper:

1. **Soft:** a run interrupted in window A is invisible in window B unless the
   user manually finds and reopens that exact chat there. No "an interrupted
   run exists for this repo" signal exists independent of the history entry.
2. **Sharper:** if the run in window A is still LIVE (not yet failed), nothing
   stops the user from starting a conflicting run against the same files from
   window B — "is this session already running" is private to A's process.
   That's a shadow-git checkpoint / concurrent-write race, not just a missed
   convenience.

Two fixes considered, neither built: a lock file per workspace root in
`globalStorage` (stops the concurrent-run case), or surfacing "resumable
elsewhere" in the history list itself (fixes the visibility case). Left open.

## 11. Follow-on: the 20GB run (2026-09-04)

Same ticket (#1534774), autonomous, 73 steps, then "Model worker stopped
responding — no activity for 5 minutes" with the IDE at 20GB on a 24GB / 12-core
Mac. The question asked was "is this debug mode?" — it was not. The dev host's
own output channel had the cause in one line:

```
$ pnpm exec jest   (cwd: apps/mms/mms-webapp, exit null, 636817ms) — run_checks test
```

Three harness defects lined up, each individually survivable:

1. **`planVerification` widened to the package.** A changed file with no sibling
   test fell back to "run the whole package": bare `pnpm exec jest` over a
   ~500-file jsdom/React suite, cores−1 = 11 workers at ~1.5GB each. The repo's
   own `test` script caps `--maxWorkers=2`; preferring the raw `jest` dependency
   bypassed it. Fixed: a missing test is reported, never papered over with
   everything — no target → actionable error, a sub-directory scopes to itself,
   the no-runner check runs first. `AutoVerifyTracker` gets a `'skipped'` verdict
   for it (it was counting as a derivation failure and retiring test checks for
   the whole run after two untested helpers).
2. **The timeout killed bash, not jest.** `child.kill('SIGKILL')` on
   `/bin/bash -lc …` left pnpm → node → 11 jest workers alive, and because they
   inherited our stdout pipe, `'close'` — and the promise — waited for them:
   "killed after 180s", 636s wall clock. Reproduced against the pre-fix build
   (1s timeout, settled in 15.5s). Fixed with `detached: true` +
   `process.kill(-pid)` (`taskkill /T /F` on Windows) and a 2s grace before a
   forced settle. A latent TDZ on the spawn-failure path went with it.
3. **The stall timer did not know about tool time.** It was re-armed only on
   worker messages, and the worker is silent while the host executes a tool —
   so any command past five minutes read as a stall, while the command ceiling
   is ten. Fixed: while a tool is in flight the window is `MAX_TIMEOUT_SEC + 60s`.

Also: `checkUnscopedVerification` now refuses unscoped *test* runs inside a
monorepo package too (`pnpm test` / `pnpm exec jest` from `apps/web`); lint and
typecheck at package level remain allowed — they do not fork a worker per core.
`.vscode/launch.json` `outFiles` excludes `node_modules` (2,845 `.js` files were
in the debugger's source-map scan — a real but minor debug-mode cost, and not
this incident).

Ruled out by reading the code: worker message buffers (capped + compacted),
webview steps (one-line summaries), ripgrep (20MB `maxBuffer` + timeout), the two
long-lived ONNX search processes (singletons, 4GB heap cap each), the ADO index
(~1MB on disk).

Verified: 213 unit tests (6 new, one proving the tree kill), 8/8 ticket evals,
bundle builds, typecheck unchanged (3 pre-existing errors in
`confluenceAuthService.ts`).
