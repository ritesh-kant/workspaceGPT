# P1.9 Live Validation — Extension Development Host checklist

The deterministic layers are covered headlessly (`pnpm units` in
`packages/agent-evals` — 35 tests over the real modules) and the agent loop is
exercised end-to-end against local qwen (`pnpm smoke`). What headless testing
CANNOT reach is below — it needs the real VS Code host. Launch with:

```bash
cd apps/vscode-extensions && pnpm run dev
```

Use a scratch clone of any small repo as the test workspace (never a repo with
uncommitted work you care about). Local model: `qwen2.5-coder:14b-ctx24k`.

## 1. Write flow — approval cards + applyWrite (the WorkspaceEdit path)

- [ ] Ask: *"rename function X to Y and update all call sites"* → diff cards
      appear, **nothing touches disk before approval** (check `git status`).
- [ ] Approve one card → file changes on disk AND in any open editor; native
      undo (⌘Z) works on the applied edit.
- [ ] Reject a card with feedback → the model receives the rejection and
      adjusts (doesn't resubmit the identical edit).
- [ ] Edit a file in the editor (unsaved) → ask the agent to edit the same
      region → approve → **unsaved user work must not be clobbered** (the
      before-mismatch guard should trigger a re-read instead).
- [ ] create_file and delete_file cards render sensibly (full-content diff /
      deletion warning).

## 2. Checkpoints — revert command UI

- [ ] After an approved multi-file run: revert command lists checkpoints with
      labels + timestamps.
- [ ] Revert to before-run → modified files restored, agent-created files
      gone, user's untracked files intact, real `git status` unchanged.
- [ ] **Redo (new fix, untested in UI): after reverting back, checkpoints made
      AFTER the revert target must still be listed and revertable-forward**
      (`cp-*` tags + `log --all` change from 2026-08-17).
- [ ] Revert during an in-flight run is either blocked or safe (no torn state).

## 3. run_command — approval + allowlist + output channel

- [ ] Ask: *"run the tests"* → approval card shows the exact command + cwd;
      output appears in the "WorkspaceGPT Agent" output channel.
- [ ] "Allow for this session" → the SAME command re-runs without a card; a
      DIFFERENT command still asks (exact-string match).
- [ ] Try to make it run `sudo whoami` → hard-blocked with the denylist
      message, no approval card at all.
- [ ] `chmod -R 777 .` is blocked (case-sensitivity fix from 2026-08-17).
- [ ] Long/looping command hits the timeout and reports `timedOut`.

## 4. Diagnostics + loop behavior in the host

- [ ] After an approved edit that introduces a type error, the agent sees
      get_diagnostics results and fixes its own mistake.
- [ ] Cancellation mid-run stops tool execution promptly (no zombie applies
      after cancel).
- [ ] Chat remains usable after a worker error (kill Ollama mid-run to test).

## 5. Org tools in agent mode (P3.1)

- [ ] With Confluence/ADO synced: *"implement ticket <ID>"* → agent calls
      search_tickets/search_docs mid-task and cites what it found.
- [ ] With no org data synced: tools return gracefully, no crash.

## 6. Audit trail

- [ ] `agent-actions.jsonl` in globalStorage gained one entry per
      approve/reject/auto action with correct `decision` values.

## 7. Agent progress UX (Antigravity-style timeline + files-changed bar)

- [ ] During a codebase run, the loading area shows a live step timeline:
      read-only steps grouped as *"Explored N files, M searches"*, the running
      step pulses, and completed steps gain result phrases ("28 results",
      "212 lines").
- [ ] *"Thought for Ns"* rows appear between tool batches; any prose the model
      narrates alongside tool calls shows as a note row (not swallowed).
- [ ] An approved edit's step row updates to `+a −r`; a rejected write's step
      shows "rejected" in red.
- [ ] run_command steps show the command, then `exit 0` + a working
      "Show output" toggle with the captured output.
- [ ] After the run, the timeline collapses to *"Worked for Xs"* on the answer
      and re-expands with all steps intact; it persists across history
      save/load (old sessions with plain-string steps still render).
- [ ] Answers that changed files get a *"N file(s) changed +a −r"* bar:
      expanding lists each file, clicking a row (or **Review**) opens a native
      original ⟷ current diff; deleted files render as `deleted` and don't
      open a diff.
- [ ] Same basename in different trees stays distinguishable without the
      tooltip: `src/components/foo.ts` shows parent `src/components`,
      `tests/components/foo.ts` shows `tests/components`.
- [ ] A long filename (e.g. `VeryLongComponentNameForReuploadData.test.ts`)
      in a ~280px sidebar ellipsizes the *name*; the parent path and +/−
      stats stay readable (path column must not collapse to a sliver).
- [ ] A root-level file (`.gitignore`, `README.md`) has an empty parent
      column; **Review** still opens its diff. An empty `filesChanged` list
      renders no bar.
- [ ] A run whose model returns no final text still produces a fallback
      answer message carrying the steps + files-changed bar (nothing vanishes).
- [ ] Non-agent (Confluence/ADO) turns are unchanged: no timeline, no bar.

Findings → fix → re-run `pnpm units && pnpm smoke` → then this checklist again.
When every box ticks: P1.9 done, P2.4 (loop hardening) is next per PHASES.md.
