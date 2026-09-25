# WorkspaceGPT — Coding Agent Roadmap (competing with Cursor / Claude Code)

> Status: **Draft for review** · Owner: Ritesh · Last updated: 2026-08-15
>
> Companion to [remote-mode.md](remote-mode.md) (the billing/privacy
> backbone, as built) and [architecture.md](../architecture.md). This doc
> answers: *what does it take to be a credible alternative to Cursor and
> Claude Code, and in what order?*
>
> The canonical statement of the positioning lives in
> [docs/north-star.md](../north-star.md) — §1 below is the working version of it.

---

## 1. Strategy: where we can actually win

Cursor and Claude Code cannot be beaten head-on by a small team: Cursor's moat
is custom fast models (tab completion, fast-apply) + capital; Claude Code's is
frontier-model access + being the lab's own harness. Competing feature-for-
feature is a losing race. **The winnable position:**

> **The coding agent that knows your whole org — and can prove it never stores
> your data.**

Three differentiators nobody in that pair offers together:

1. **Org-knowledge grounding.** The agent's tools include *your Confluence and
   Azure DevOps*, not just the repo. "Implement D2C-4312" → the agent reads the
   ticket, the design page, *and* the code. Cursor/Claude Code start from the
   repo and a prompt; we start from the org's actual context. (Already built:
   Confluence/ADO RAG, `workspacegpt-mcp`.)
2. **A real privacy story, in two flavors.** Local mode: fully offline, no
   account, nothing leaves the machine — for the strictest environments.
   Remote mode: zero-readable-content-at-rest (client-side encryption, per the
   SaaS design). Cursor's privacy mode is a promise; ours is architecture.
3. **The deploy loop, not just the code loop.** `release-core` (config-sync,
   hotfix cherry-pick → tag → release) means the agent doesn't stop at "PR
   opened" — it participates in shipping. No competitor touches this.

Target buyer: **enterprise/regulated teams** whose knowledge lives in
Confluence/ADO and whose security teams veto tools that hold code server-side.

Explicit non-goals (v1–v2): tab completion (requires a custom FIM model served
at <100 ms — Cursor's actual moat; a bad version is worse than none), custom
trained models, a standalone IDE fork (stay an extension: zero switching cost,
and forks like Antigravity are already a distribution channel via Open VSX).

---

## 2. What exists today (assets to reuse)

| Asset | State | Role in the agent |
|---|---|---|
| Tool-calling loop in chat (`modelWorker.ts` TOOL_DEFS) | working | the agent loop seed |
| Read tools: ripgrep search, read file, list/find files, LSP symbols/defs/refs, repo orientation ([codebaseTools.ts](../../apps/vscode-extensions/src/services/codebase/codebaseTools.ts)) | working, read-only | the "explore" half of the agent |
| Confluence + ADO RAG (sync, embeddings, Qdrant/local store) | live | org-knowledge tools |
| Live codebase tools (search, reads, LSP navigation, repo orientation) | working | workspace exploration without a persistent index |
| `workspacegpt-mcp` | exists | MCP surface for our tools |
| `release-core` + deployment engine (plan→approve→apply, audit log) | built | deploy-loop tools |
| Task→model routing (`REMOTE_TASK_MODELS`) | client-side | becomes server-side per-plan routing |
| SaaS backbone (metering proxy, encryption, Stripe) | designed | commercial layer |
| Query classifier, content hashing, key failover | working | plumbing |

The gap, in one line: **the agent can read but not act.** Everything below is
about adding write/execute/verify with the trust machinery that makes users
allow it.

---

## 3. Required capabilities — the full list

### A. Agentic core (the biggest build)

- **A1. Write tools:** `edit_file` (string-replace edits — search/replace
  blocks; full-file rewrite fallback for small files), `create_file`,
  `delete_file`. Edits validated (exact-match-or-fail) and applied via
  `WorkspaceEdit` so undo works natively.
- **A2. Execute tool:** `run_command` (terminal exec) with output capture,
  timeout, cwd control. This is what turns "edits" into "verified edits"
  (build/test/lint after change).
- **A3. Permission model:** per-tool-class policy (read = auto; write = auto
  with review; execute = ask / allowlist / auto per session). Command
  allowlist + denylist (no `rm -rf`, no network exfil by default). This is a
  *product* feature, not plumbing — trust is the adoption gate.
- **A4. Checkpoints & rollback:** snapshot before each agent action (shadow
  git or file snapshots); one-click "revert to before this step / this run."
  Cursor and Claude Code both have this; table stakes.
- **A5. Diff review UI:** editor-area panel (reuse the deployment PlanReview
  pattern — grouped diff, approve/reject per file, "nothing applied yet"
  badge). The plan→approve→apply spine from `release-core` is *exactly* the
  right interaction model — generalize it from config vars to code edits.
- **A6. Agent-loop hardening:** streaming with mid-run cancellation, tool-call
  retries, loop/stall detection, max-turn budget, error recovery ("test failed
  → read output → fix → rerun").
- **A7. Context-window management:** token accounting per model, conversation
  compaction/summarization when near the limit, file-read windowing (already
  partially there via `startLine`/`endLine`).
- **A8. Prompt caching:** system prompt + tool defs + repo orientation as a
  stable cached prefix (Anthropic/Gemini both support it) — agentic loops are
  10–50× the tokens of RAG chat; caching is the difference between viable and
  non-viable unit economics.
- **A9. Rules/instructions file:** `.workspacegpt/rules.md` (+ auto-read
  CLAUDE.md / .cursorrules for zero-friction migration — read competitors'
  config files; it's free onboarding).
- **A10. Sub-agents / background tasks (v2):** parallel explore agents,
  long-running task queue.

### B. Context engine

- **B1. Live codebase exploration:** improve repo orientation, focused search,
  and LSP navigation without creating or storing a codebase embedding index.
- **B2. Repo map:** compressed file-tree + key-symbol skeleton injected into
  the system prompt (`buildRepoOrientation` is the seed — extend with LSP
  document symbols, ranked by import-graph centrality).
- **B3. LSP diagnostics tool:** surface compile/type errors to the agent after
  each edit (`vscode.languages.getDiagnostics`) — cheapest verification signal
  there is, and IDE-native (an edge over terminal-only Claude Code).
- **B4. Git context tools:** status/diff/log/blame as read tools; branch,
  stage, commit (message drafted, user approves) as write tools.
- **B5. @-mention context:** files, folders, symbols, Confluence pages, ADO
  tickets in the chat input — one mention model across code + org knowledge
  (the fusion *is* the differentiator).

### C. Org-grounding (the moat — mostly done, needs exposure)

- **C1.** Expose existing RAG as agent tools: `search_docs`, `search_tickets`,
  `read_page`, `get_ticket` — so the agent pulls org context *mid-task*, not
  only when the user pastes it.
- **C2.** Ticket-to-PR flow: "implement D2C-1234" → read ticket → find design
  page → locate code → plan → edit → test → draft PR description citing the
  ticket. This end-to-end demo is the marketing.
- **C3.** MCP **client** support (consume third-party MCP servers) in addition
  to the existing MCP server — table stakes for extensibility parity.
- **C4.** Deploy-loop tools (v2): expose `release-core` plan/apply as agent
  tools behind the same approval gates.

### D. Model layer

- **D1. Remote (managed):** extend the SaaS chat proxy for agentic traffic —
  tool-call passthrough, long streams, prompt-cache headers, per-plan routing.
  Agent quality is decided by the model: route agent tasks to frontier tiers
  (Claude Sonnet-class for agentic editing; flash-tier for classification/
  titles). **Model choice is a server-side config** — we can chase the best
  agent model without shipping an extension update.
- **D2. BYOK tier:** user's own Anthropic/OpenAI/Gemini key through our
  harness at a lower subscription price — hedge against "your margin is my
  markup" objections, and the cheapest way to serve power users.
- **D3. Local mode honesty:** agentic editing with 7B Ollama models produces
  garbage edits. Local mode ships the same tools but sets expectations
  (read/explain/search work well; multi-file refactors need remote). Do not
  market local mode as Cursor-parity.
- **D4. Cost telemetry:** per-run token/cost display in the UI (builds trust
  and prices the quotas).

### E. Product surfaces

- **E1.** Agent panel: sidebar chat stays; agent runs get the editor-area
  panel (plan, live tool-call feed, diffs, checkpoint timeline).
- **E2.** Inline edit (⌘K on selection) — high value, modest cost once A1
  exists (v1.5).
- **E3.** Terminal integration: show `run_command` in a real VS Code terminal,
  not a hidden buffer — visibility builds trust.
- **E4.** Session history/resume for agent runs (chat history exists; extend
  with tool-call transcripts + checkpoints).

### F. Trust, safety, compliance (enterprise gate)

- **F1.** Workspace-boundary sandbox: tools refuse paths outside the
  workspace; secret-file denylist (`.env`, key files) by default.
- **F2.** Audit log of every agent action (reuse `FileAuditLog` JSONL from the
  deployment engine).
- **F3.** Data-flow one-pager for security reviews: what leaves the machine in
  each mode, what's stored where, encrypted with whose key. (The SaaS design's
  §6, productized as a sales asset.)
- **F4.** ToS/model-provider terms review; opt-in telemetry only.

### G. Commercial & distribution

- **G1.** Pricing anchored to Cursor's ~$20/seat: Free = local mode + BYOK
  limited; Pro ≈ $20 managed with agent quotas; Team = shared org index +
  admin/audit. **Quota design must assume agentic burn** (one agent run ≈
  10–50 RAG chats) — meter tokens, not messages.
- **G2.** Marketplace + Open VSX (already done) + fork deeplinks (Antigravity
  pattern) — forks are underserved distribution Cursor can't touch.
- **G3.** Eval harness before marketing: a private suite of ~50 repo tasks
  (bug-fix, feature, refactor) scored on pass-rate + cost; run per model
  route change. Without this, model routing changes are guesswork.
- **G4.** Docs + a 3-minute demo video of C2 (ticket→PR with org context).
- **G5.** X promotion pipeline (already running) pivots to agent demos.

---

## 4. Build order

> **Superseded by [docs/roadmap.md](../roadmap.md)** — the canonical master phase plan
> that merges this table with the SaaS build order. The table below is kept
> as the original one-glance rationale.

| Phase | Ships | Contents | Why this order |
|---|---|---|---|
| **1. Agent MVP** | "it edits and verifies" | A1 edit tools + A5 diff review + A4 checkpoints + A3 minimal permissions + B3 diagnostics + B4 git-read | Smallest thing that changes the product category; read tools already exist |
| **2. Agent that runs things** | "it tests its own work" | A2 run_command + E3 terminal + A6 hardening + A7 context mgmt + A9 rules files | Execution needs the trust UI from phase 1 in place first |
| **3. The moat** | "it knows your org" | C1 org tools in agent + B5 @-mentions + C2 ticket→PR demo + B1 live codebase exploration + B2 repo map | Differentiation on top of a working agent, not instead of one |
| **4. Commercial** | "it's a business" | D1 proxy extension + A8 caching + D4 cost display + G1 pricing + F2/F3 + G3 evals | SaaS backbone (REMOTE-MODE-SAAS steps a–h) can proceed in parallel from phase 1 |
| **5. Parity & polish** | "no reason to leave" | E2 inline edit + C3 MCP client + A10 sub-agents + C4 deploy tools + E4 resume | Catch-up features after the wedge is sharp |

Dependency note: SaaS design **step a** (managed chat proxy) is needed by
phase 4 at the latest, but building it during phase 1–2 lets remote-mode agent
development run against the real proxy from day one.

---

## 5. Honest risk register

| Risk | Mitigation |
|---|---|
| Cursor/Claude Code ship org-connectors (Atlassian MCP exists) | Speed on C2 + the *combined* story (org context **and** provable privacy **and** deploy loop) — each piece is copyable, the bundle is positioning |
| Agent quality below users' Cursor-calibrated bar | It's mostly the model: route to frontier models (D1), measure with G3 evals, don't ship agent mode to marketplace until eval pass-rate is respectable |
| Token costs sink margins | A8 caching, flash-tier routing for cheap tasks, hard quotas, BYOK escape valve |
| Solo-dev bandwidth vs this list | Phases are strictly cut-lines; each phase alone is a shippable, marketable release. Phase 1–2 ≈ the whole "assistant→agent" pivot |
| VS Code API limits (vs a fork's freedom) | Accept: no custom tab UX. The wedge doesn't need it; forks-as-distribution partially inverts the disadvantage |

---

## 6. Open items

| # | Question | Gates |
|---|---|---|
| 1 | Edit format: search/replace blocks vs unified diff vs full-file — pick per eval results, models differ | **DECIDED (2026-08-15): search/replace** (as structured `edit_file` tool args). qwen2.5-coder-14b matrix: search-replace 60% pass / 70% apply-ok / 375 avg output tokens; unified-diff 40/40/221 (fabricates hunk context); full-file 60/60 but **3× the tokens (1110) and 2× the latency (141s vs 73s)** with truncation risk on big files. Search/replace's failure mode is also the safest: a miscopied SEARCH is *rejected*, never mis-applied, and the error feeds back for a retry. Matches the shipped `edit_file(oldString,newString)` semantics. Frontier-model rows pending a working API key (Gemini 2.5 ids returned "no longer available to new users" 404s). |
| 2 | Checkpoints: shadow git repo vs snapshot files — shadow git handles multi-file atomically | **DECIDED (2026-08-15): shadow git** — separate `--git-dir` under globalStorage, workspace as `--work-tree`, `info/exclude` for `.git/`; workspace `.gitignore` respected automatically. Spike verified: atomic multi-file revert incl. agent-created-file removal, captures user's *uncommitted* state, untracked user files survive, real repo untouched, free per-checkpoint diffs, ~2.7s cold / fast incremental. |
| 3 | Which frontier model(s) for the managed agent tier (Claude Sonnet-class vs Gemini Pro) — decided by G3 evals + margin | Phase 4 |
| 4 | Agent quota unit for pricing (tokens vs "agent runs") | Phase 4 |
