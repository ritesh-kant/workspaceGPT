# Debug mode: working bug tickets to a proven root cause

Status: phases 1-3 BUILT 2026-10-12 on branch feat/debug-mode (uncommitted).
Phase 4 (debugger) parked, per decision 4. Verified: type-check, lint, 25 new
unit tests, 4 scripted end-to-end scenarios through the real worker
(`pnpm --filter @workspace-gpt/agent-evals debug-evals`), and the composer toggle
in the webview preview. NOT verified: a live run with a real model on a real Bug
ticket, and the real VS Code write path (`applyEdit`) outside the headless stub.
All five decisions in section 7 were settled "go with the recommendations".

Goal: take a bug ticket to a confirmed root cause and a verified minimal fix,
with the evidence shown. Debug mode is a task shape (like a spike), not a fifth
value on the Plan / Manual / Auto / Full dial, which is the permission axis
(see `permission-modes.md`).

## 1. What exists today

- No Bug path in code. Bug-ness has two effects only: a "Root cause" section in
  `FINAL_REPORT_FORMAT` (`promptTemplates.ts:164`) and the `fix/` branch prefix
  (`shipHelpers.ts:35-40`). Bugs otherwise take the generic implement path
  (`TICKET_IMPLEMENT_MANDATE`, `modelWorker.ts:1205-1216`).
- Ticket intake drops bug data: ADO `Microsoft.VSTS.TCM.ReproSteps` and
  `SystemInfo` are never read; only the parent id of the relations is used;
  non-image attachments (logs, HAR) are not fetched; comments cap at the 3 most
  recent at 300 chars (`promptTemplates.ts:~62-64`). Jira has no AC and only
  inline description images (`jiraIssueService.ts:125`).
- Observation tools: `run_command` / `check_command` (child_process capture),
  `get_diagnostics`, `git_blame` / `git_log` / `git_diff`, LSP tools, and on
  desktop `browser_console` / `browser_network`. No debugger tool, no log
  reader.
- Verification (`AutoVerifyTracker`, `autoVerify.ts`) is write-triggered, so a
  reproduce-only run never triggers it.
- The spike flow is the template: type predicate (`constants.ts:1296-1342`),
  prompt block + report format (`promptTemplates.ts:198,253,363-388`), terminal
  gate (`answerGates.ts:205`), `turnAction` (`chatService.ts:978-1002`), tool
  subset (`toolScope.ts` `TURN_ACTION_TOOL_NAMES`).

Known failure modes this design targets: unsourced claims presented as fact
(ticket 1520855), an invented edit with a 13-minute search
(Confluence "Option 4"), and runs that end on a symptom rather than its origin.

## 2. Entry

- A Bug-type ticket (`bug|defect`, a fact from the tracker) enters debug mode.
- A manual "Debug this" action enters it for any ticket or free text.
- Never inferred from keywords in user text: a regex over user text may only
  add a detection, never gate capability or budget.
- Orthogonal to the dial. Plan still means no writes (so no probes, no fix).

## 3. The loop

Intake → Reproduce → Observe → Root cause → Minimal fix → Regression test →
Verify → Report.

Outcomes are one of: **confirmed**, **probable** (with the single check that
would settle it), **not found** (with what was ruled out). Never a forced edit.
When it needs data or environment access it uses `ask_user`.

## 4. Mechanisms for finding the root cause

1. **Evidence gate.** A root-cause claim must cite recorded run evidence: a
   failing test or command output, a stack frame, a probe line. Code reading
   alone yields "Hypothesis". Extends the reference provenance index (ids link
   by what the run recorded) to evidence ids.
2. **Counterfactual proof.** Confirmed only when the repro is red before the
   fix, green after, and red again with the fix reverted (`git stash` +
   `run_checks`). Probes are removed first.
3. **Hypothesis ledger** as run state, not model context: hypothesis, predicted
   observation, check run, result (confirmed / refuted / untested). At least
   two competing hypotheses before editing. Shown in the report. Survives long
   runs and resume.
4. **Anchors** (add-only detections): parse stack traces to `file:line` and open
   those frames first; grep the exact error string; use the failing test name.
   With no anchor, the agent must produce one by reproducing.
5. **Regression window:** `git log` / `git_blame` on suspect lines; when a
   deterministic repro command exists, `git bisect run <repro>`.
6. **Backward causal chain:** from where it fails to where the first wrong value
   originates; the report names the first wrong state, not the crash site.
7. **Org Knowledge:** search Confluence, ADO and Jira for the same error,
   closed bugs with the same signature and their fix commits, runbooks, linked
   items. Cite what was found, and say so when nothing was.
8. **Differential debugging:** compare a working and a failing case (input,
   data, environment, version); name the smallest difference.
9. **Log probes** (section 5).

## 5. Log probes

The agent tests a hypothesis by running the repro with logs added and reading
what actually happened.

- `add_probe(file, line, expr, hypothesisId)`: the host writes a log line in
  the file type's syntax (derived from the extension) carrying a marker
  `WGPT-PROBE:<id>`, and records file, line, id, hypothesis and the predicted
  value.
- Run the repro with `run_command` / `run_checks`; for web bugs on desktop read
  `browser_console`; for long-running processes read the background job log.
- `probe_output(id)` filters captured output by marker, truncated and sampled
  for loops. The result is stored as an evidence id and marks the hypothesis
  confirmed or refuted against its prediction.
- `remove_probes` deletes by marker. A probe tracker (modelled on
  `autoVerify.ts`) treats leftovers as debt: the final report and any
  commit/PR are blocked until none remain. A marker grep at ship time is the
  backstop.
- Probe edits are exempt from `AutoVerifyTracker` (verification subprocesses
  were ~63% of run time).
- Permissions: a `probe` action kind in `permissionPolicy.ts` `decide()`,
  auto-approved in Manual (tracked and always reverted), refused in Plan.
- Prefer no-source-edit options when available: env flags (`DEBUG=*`) and,
  later, debugger logpoints.
- Safety: expressions side-effect free, no change to async or control flow, no
  secrets or tokens logged (mask likely secret fields), cap on probes per run.
- Privacy: probe output stays in the local run; analytics carry no content.

## 6. Phases (each shippable alone)

1. **Intake and prompt.** Fetch `ReproSteps`, `SystemInfo`, relations and text
   attachments (ADO first, then Jira) into `TicketDetail` /
   `TicketPromptContext`; raise the comment cap for bugs. Debug prompt block and
   `DEBUG_REPORT_FORMAT` (symptom, repro, root cause with `file:line`, fix,
   before/after evidence, regression test, other callers at risk, not
   verified). Debug tool subset via `forTurnAction`. Anchors (4) and Org
   Knowledge search (7). Terminal gate in `answerGates.ts`.
2. **Evidence core.** Repro-first soft gate (nudge + `ask_user`, driven by
   recorded run state, not regex); hypothesis ledger (3); log probes (5);
   evidence gate (1); regression-test debt in `AutoVerifyTracker`.
3. **Proof.** Counterfactual check (2) and bisect (5); both need a repro
   command from phase 2.
4. **Debugger (parked).** DAP and logpoints, VS Code only; desktop
   `vscode-compat` lacks the debug API.

Touch points: `App.tsx` (entry action), `ChatMessageHandler.ts`,
`chatService.ts` (`turnAction`), `modelWorker.ts`, `toolScope.ts`,
`promptTemplates.ts`, `answerGates.ts`, `permissionPolicy.ts`,
`adoWorkItemService.ts`, `jiraIssueService.ts`, `tickets/types.ts`. Prompt text
must not match `IMPLEMENT_MANDATE_RE` / `hasWriteIntent` (pinned by a unit
test), as with the spike prompt.

## 7. Decisions (recommendation first)

1. Entry: Bug type auto-enters, plus manual "Debug this". Recommended.
2. Repro gate: soft (nudge + `ask_user`), never a hard refusal. Recommended.
3. Scope: ADO first, then Jira. Recommended; Jira has known gaps
   (`jira-flow-audit`).
4. Phase 4 debugger: parked. Recommended.
5. Probe edits auto-approved in Manual. Recommended.

## 8. Evals

Seeded bugs in `packages/agent-evals`, varied difficulty: stack trace present,
no trace, bisectable regression, data-dependent (reading can't settle it),
cause two layers from the symptom, decoy cause nearby. Score: root cause
matches the seeded location, repro before edit, counterfactual passes, no probe
in the final diff, and false "confirmed" claims (the number that matters most).

## 9. Not verified

No live run with a real model. Scripted runs prove the harness mechanisms fire in
the real worker; they say nothing about whether a real model reasons better.

## 10. What was built (and where)

| Piece | Where |
|---|---|
| Bug type + button prompt (`isBugWorkItem`, `debugWorkItemPrompt`) | `constants.ts`, re-exported in `webview/src/constants.ts` |
| Intake: repro steps, system info, relations, text attachments (ADO, Jira) | `adoWorkItemService.ts`, `jiraIssueService.ts`, `tickets/types.ts`, `tickets/attachmentText.ts` |
| Debug prompt block, `DEBUG_REPORT_FORMAT`, bug thread cap 3→8 | `utils/promptTemplates.ts` |
| Entry: Bug ticket + implement/autonomous/plan, or the composer's Debug toggle (`debug` send flag) | `chatService.ts` (`debugMode`), `ChatMessageHandler.ts`, `webview/src/App.tsx` |
| Tools (offered only when `toolAvailability.debug`): `debug_ledger`, `add_probe`, `probe_output`, `remove_probes`, `counterfactual_check`, `git_bisect` | `modelWorker.ts` TOOL_DEFS, `toolScope.ts` |
| Probe lines (pure): syntax per language, expression and insertion-point checks, insert/remove/extract | `services/agent/debugProbes.ts`, `agentWriteTools.ts` (`prepareProbeInsert/Removal/Restore`) |
| Probe output on `run_command` / `run_checks` / `check_command` / `browser_console` results | `services/agent/debugService.ts` (`withProbeOutput`) |
| `probe` permission kind: never a card, refused in Plan (tool withheld) | `permissionPolicy.ts`, `chatService.gatedWrite` |
| Probes removed at run end, on Stop, and refused at ship time | `chatService.cleanupProbes`, `shipService.assertNoProbes` |
| Hypothesis ledger, evidence ids, repro red/green, counterfactual state, claim check | `workers/model/debugState.ts`, wired in `modelWorker.ts` |
| Soft edit gate (once), "confirmed" claim gate (twice, then a stamp), honest "probable / not found" ending without a forced edit | `modelWorker.ts` |
| Counterfactual (revert fix → run test → restore, restoration verified) and bisect (clean tree, card, always reset) | `services/agent/debugService.ts`, `chatService.ts` |

Deviations from the plan, and limits worth knowing:

- Probe output is attached automatically to the result of the command that
  produced it; `probe_output` only re-reads it (background jobs).
- The ledger lives in the worker, so a resumed run (new worker) starts with an
  empty ledger and evidence list.
- The counterfactual can come back red for the wrong reason (an import error
  from the revert). The result says so and shows the output tail; the model
  judges it.
- Bisect needs a clean working tree, so it must come before any edit or probe.
  Dependencies that differ across history can make the repro fail for other
  reasons.
- A resume or an approved plan keeps Debug mode (`run.lastDebugMode`), so a follow-up that does not name the ticket keeps its tools.
- Probes cover JS/TS, Python, Go, Ruby, Java/Kotlin, C#, Rust and PHP. Other
  files get an error pointing at `run_command`.
- Mixed-in repro detection is by exit code of a command that failed before the
  first non-test edit and passes after it: a different command is not matched.
