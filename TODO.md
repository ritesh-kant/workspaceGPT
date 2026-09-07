# TODO

Deferred work, with enough context to pick up cold. Newest first.

## Measure real context usage before building compaction

**Status:** waiting on data, 2026-09-06.

The composer's context meter now reports real occupancy (`AGENT_CONTEXT`, measured
from the provider's `usage.prompt_tokens`). Nothing in the eval suite produces a
200k-token conversation, so the exhaustion path, the meter's warn/critical states,
and the truncation threshold are all unexercised against a real run.

Run real tickets for a week and note the peak. If normal work tops out at 40-60%,
compaction below is premature and sub-agents are the better investment. If runs
routinely reach 90%, build it.

## Automatic context compaction (summarize-and-continue)

**Status:** deliberately not built. Deferred by Ritesh, 2026-09-05.

**Why it is wanted:** the agent loop no longer has a turn cap — a run is bounded
by the context window instead (`src/workers/model/contextBudget.ts`), which is
the honest limit and the one shown in the composer's context meter. But without
compaction, a full context still *ends* a run. Claude Code continues past that
point by summarizing the conversation and carrying on, which is what makes a
genuinely long task finishable.

**What it would be:** at `COMPACT_AT_PCT` (75% of the managed window), one
no-tools model call that writes down what the run has established — files read
with `path:line` anchors, the root cause and its evidence, changes already
applied and whether each was verified, and what is still to do — replacing the
messages it summarizes. Keep `messages[0]` (the task) and the most recent rounds
intact. Rebuild `toolResultLog` indices and `toolCharsUsed` afterwards, since
both point into the array being spliced. Fall back to the existing truncating
`compactOldToolResults` if the summary call fails or returns empty.

A working version of exactly this was written and then removed on 2026-09-05;
recover it from that day's session if useful rather than starting cold.

**Why it was deferred:** compaction is lossy, and making it automatic makes it
load-bearing — every compaction is a chance to drop the fact that mattered,
mid-investigation, silently. Worth doing deliberately rather than as part of
removing the turn cap.

**Watch out for:** re-measuring context immediately after compacting (the
pre-compaction number would otherwise trigger a compaction every turn); and the
`agent-context` message the meter reads, which should report the drop so the
user can see what happened.
