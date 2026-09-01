# WorkspaceGPT — Master Phase Plan

> Status: **Canonical sequencing** · Owner: Ritesh · Last updated: 2026-08-25
>
> One place that orders ALL planned work. Merges the build orders from
> [CODING-AGENT-ROADMAP.md](CODING-AGENT-ROADMAP.md) (items A1–G5),
> [REMOTE-MODE-SAAS-DESIGN.md](REMOTE-MODE-SAAS-DESIGN.md) (steps a–h), and
> [TICKET-ENTRY-POINT-DESIGN.md](TICKET-ENTRY-POINT-DESIGN.md) (steps 1–5,
> feeding P3.1/3.2/3.5).
>
> **Status (2026-08-15):** P0 ✅ (0.1 matrix still finishing on qwen; shadow-git
> decided). **P1 ✅ code-complete** — write tools + diff-review cards +
> checkpoints/revert command + diagnostics + git read tools, all building.
> **P2 core ✅** — run_command (denylist → approval → execute), session
> allowlist, agent-actions.jsonl audit, rules-files injection (.workspacegpt/
> rules.md, CLAUDE.md, .cursorrules, AGENTS.md). **P3.1 ✅** — search_docs /
> search_tickets exposed as agent tools. **P1.9 ✅ (2026-08-17)** — headless
> harness (`packages/agent-evals`: `pnpm units` 35 tests + `pnpm smoke` vs
> local qwen) found+fixed 4 bugs (checkpoint git-init, revert redo-loss,
> chmod denylist, multi-JSON salvage) and added 7 loop scaffolds (sequential
> writes, auto-diagnostics, failed-write/phantom-change honesty gates, repeat
> breaker, self-disambiguating edit errors — most of **P2.4** landed here);
> EDH write-flow confirmed live (cards → approve → apply → revert pending).
> Local-model ceiling characterized: qwen-14B ~60% single-edit, compounds on
> multi-file — D3 boundary, skills (2.9) + remote tier are the mitigations.
> **P3.1 extended (2026-08-24)** — [TICKET-ENTRY-POINT-DESIGN.md](TICKET-ENTRY-POINT-DESIGN.md)
> steps 1–3 landed: `get_ticket` (live exact-ID ADO read — fills the gap
> `search_tickets`'s semantic RAG search can't cover), `listMyWorkItems` +
> cache, and the "Your work" `MyWorkPanel` in the chat empty state (replacing
> the old hero greeting, now `HomeGreeting` + collapsible `QuickTipsSection`).
> Unit-tested (47 assertions across the three pieces), host type-checks and
> builds; **pending live verification** against a real ADO ticket (rides the
> same EDH pass as the P1.9 tail below). Step 4 (ticket `@`-mention kind) and
> step 5 (prompt tuning + 5-ticket eval) not started.
>
> Remaining: EDH checklist tail (reject-feedback, revert UI, allowlist) +
> Ticket Entry Point live verification, P2.5 context mgmt, P2.8 git write
> tools, P2.9 skills, P3.2 (incl. ticket `@`-mentions), P3.3–3.6, E3;
> **B1 shipped 2026-08-31** on Cloudflare (not AWS): GitHub sign-in + session
> API, and the OpenAI-compatible `/v1/chat/completions` proxy to OpenRouter with
> per-request session validation and a configurable per-user weekly cap — see
> CLOUDFLARE-REMOTE-MODE-DESIGN.md. One blocker to usability: `REMOTE_AUTH.API_BASE`
> still points at localhost. B2 is **dropped** (the index stays local); B3 is
> reduced to Stripe, blocked on a pricing decision. Also shipped this week, outside
> this roadmap's phase gates: **Track X** (general product UX — message
> editing, sidebar auto-collapse, collapsible Settings).
> Those docs own the *what/why*; this doc owns the *when*. Each phase is a
> shippable cut-line: if work stops after any phase, the product is still
> better and releasable.

**Two tracks run in parallel:**
- **AGENT track** — extension work (the product).
- **BACKEND track** — SaaS work (the business), on **Cloudflare Workers**
  (`apps/workspacegpt-api`). Independent codebase, can proceed alongside any
  agent phase.

```
 AGENT:    P0 ──▶ P1 ──▶ P2 ──▶ P3 ─────────▶ P5
                                      ╲      ╱
 BACKEND:        B1 ──────▶ B2 ──▶ B3 ─▶ P4 (converge: commercial launch)
```

---

## Phase 0 — Decisions & spikes (AGENT + BACKEND, small)

De-risk before building. No product code ships.

| # | Item | Output |
|---|---|---|
| 0.1 | **Edit-format spike** (roadmap open item 1): search/replace blocks vs unified diff vs full-file, tested against 2–3 candidate models on ~10 real edits in this repo | decision + the 10 edits become eval seeds |
| 0.2 | **Checkpoint mechanism spike** (open item 2): shadow git repo vs file snapshots | decision |
| 0.3 | **S3 Vectors spike** (SaaS open item 1): GA status, latency at our topK, per-tenant index model | S3 Vectors vs t4g-Qdrant decision |
| 0.4 | **Eval harness seed** (G3): runner + ~10 scored tasks (grow to 50 by P5) | `packages/agent-evals` skeleton |

**Exit:** all four decisions written into the docs' open-items tables.

---

## Phase 1 — Agent MVP: "it edits, you review, you can undo" (AGENT, large)

The category change from assistant to agent. Read tools already exist.

| # | Item | Scope |
|---|---|---|
| 1.1 | A1 write tools | `edit_file` / `create_file` / `delete_file`, exact-match-or-fail, applied via `WorkspaceEdit` |
| 1.2 | A5 diff review UI | editor-area panel, generalized from deployment `PlanReview`; approve/reject per file |
| 1.3 | A4 checkpoints | per-0.2 decision; revert to before any step/run |
| 1.4 | A3 permissions (minimal) | read=auto, write=review-required; no execute yet |
| 1.5 | B3 diagnostics tool | LSP errors surfaced to the agent after each edit |
| 1.6 | B4 git read tools | status / diff / log / blame |
| 1.7 | E1 agent panel (v0) | live tool-call feed + diffs + checkpoint timeline |
| 1.9 | **Live validation** (added 2026-08-17) | manual test pass of ALL built-but-untested work (P1, P2-core, P3.1) in the Extension Development Host: multi-file edit + review + revert, run_command approval/denylist, org tools; fix what breaks. Blocks every later phase — nothing built after 2026-08-15 has run live |

**Exit demo:** "rename this API and update all call sites" — agent explores,
edits multiple files, diagnostics verify, user reviews diff, applies, then
rolls back cleanly. Ships as a pre-release to early users.

**Out:** running commands, org tools in agent, anything billing.

---

## Phase 2 — Execution & hardening: "it verifies its own work" (AGENT, large)

| # | Item | Scope |
|---|---|---|
| 2.1 | A2 `run_command` | timeout, output capture, cwd control |
| 2.2 | E3 terminal integration | commands visible in a real VS Code terminal |
| 2.3 | A3 permissions (full) | ask / session-allowlist / auto per tool class; command deny-list; F1 workspace sandbox + secret-file denylist |
| 2.4 | A6 loop hardening | cancellation, stall/loop detection, max-turn budget, fail→read-output→fix→rerun recovery |
| 2.5 | A7 context management | token accounting, compaction near limit |
| 2.6 | A9 rules files | `.workspacegpt/rules.md` + read `.cursorrules`/`CLAUDE.md` |
| 2.7 | F2 audit log | every agent action → `FileAuditLog` JSONL |
| 2.8 | B4 git write tools | branch / stage / commit (user approves message) |
| 2.9 | **Skills: carve-out + router** (added 2026-08-17, [SKILLS-DESIGN.md](SKILLS-DESIGN.md) steps 1–2) | `skillFiles.ts` loader + built-in skills carved from `promptTemplates.ts` (behavior-neutral first), then `skillRouter.ts` deterministic selection + analytics. Pairs with 2.5: both shrink per-turn prompt |

**Exit demo:** point the agent at a failing test; it reads the failure, fixes
the code, reruns the test to green, commits on approval — with every command
visible and every action audited. Marketplace-quality "agent mode (beta)".

**Out:** codebase RAG, org tools, sub-agents.

---

## Phase 3 — The moat: "it knows your org" (AGENT, medium)

Differentiation on top of a working agent. This phase is the marketing.

| # | Item | Scope |
|---|---|---|
| 3.1 | C1 org tools in agent | `search_docs` / `search_tickets` (semantic, RAG) — **done** |
| 3.1b | **Ticket entry point** (added 2026-08-24, [TICKET-ENTRY-POINT-DESIGN.md](TICKET-ENTRY-POINT-DESIGN.md) steps 1–3) | `get_ticket` exact-ID ADO tool + `listMyWorkItems`/cache + "Your work" panel in the chat empty state. Code-complete, unit-tested; **pending live verification** |
| 3.2 | B5 @-mentions | files, symbols, Confluence pages, ADO tickets in one mention model — ticket kind is ticket-entry-point step 4, not started |
| 3.3 | B1 codebase RAG revival | dormant jina-code path: incremental, hash-skipped, gitignore-aware; semantic `search_code` tool |
| 3.4 | B2 repo map | `buildRepoOrientation` + LSP symbols, import-graph ranked, in the cached prompt prefix |
| 3.5 | C2 ticket→PR flow | "implement D2C-1234" end-to-end; record the 3-minute demo (G4) — 3.1b supplies the precise ticket read this needed; remaining is step 5 (prompt tuning + eval on 5 real tickets) |
| 3.6 | **Workspace + third-party skills** (added 2026-08-17, [SKILLS-DESIGN.md](SKILLS-DESIGN.md) steps 3–4) | `.workspacegpt/skills/*.md` + authoring guide; `.claude/skills/*/SKILL.md` compat + `triggers.json` overlay. Team-encoded procedures = enterprise stickiness |

**Exit:** the demo video exists and is reproducible on a fresh repo; G5 (X
pipeline) starts posting agent demos.

**Decided 2026-08-31:** local-even-in-remote. Code (and Confluence/ADO)
indexing is local in both modes; the mode switch moves inference only.

---

## Backend B1 — Managed chat proxy (BACKEND, medium) · **SHIPPED 2026-08-31**

Built on Cloudflare Workers, not AWS. See
[CLOUDFLARE-REMOTE-MODE-DESIGN.md](CLOUDFLARE-REMOTE-MODE-DESIGN.md) for the
as-built design; [REMOTE-MODE-SAAS-DESIGN.md](REMOTE-MODE-SAAS-DESIGN.md) is
superseded.

- `apps/workspacegpt-api`: GitHub sign-in (`/auth/*`, KV sessions, D1 accounts,
  60-day account-age gate) + `POST /v1/chat/completions` — OpenAI-compatible
  streaming proxy to OpenRouter on the vendor's key, with tool-call passthrough.
- Session validated on **every** inference request; no client-side grace period.
- Per-user weekly request cap (200/week default) in D1, keyed on the existing
  `plan` column, with a per-user override. The cap and the managed model id are
  both changeable at runtime via an `app_config` table — no redeploy.
- Client cutover done in the same pass: remote mode now points the existing
  OpenAI client at the Worker with the session token as its key. The
  client-side `REMOTE_TASK_MODELS` table is deleted — one managed model,
  chosen server-side.
- No request or response bodies are logged, anywhere in the data plane.

**Exit met**, except: `REMOTE_AUTH.API_BASE` must be swapped to the deployed
Worker URL, and a live streaming/tool-calling run against a real
`OPENROUTER_API_KEY` is still unverified. Prompt-cache headers (D1) and
per-plan model tiers deferred to Phase 4.

## Backend B2 — Managed index — **DROPPED**

Remote mode sells managed *inference*, not a managed index: embeddings and the
vector store stay on the user's machine in both modes. That removes the entire
reason B2 existed (per-tenant vector storage, client-side AES-GCM, share bundle
v3) and with it the "vendor-readable content at rest" risk — no customer content
reaches vendor storage at all.

The one casualty is **Share-to-Chrome**, which needs a network-reachable index;
it is parked, not deleted (see §1 of the design doc). Revive B2 only if sharing
becomes worth a hosted index.

## Backend B3 — Billing plumbing (BACKEND, small) · *reduced*

SaaS step **g** only — the client cutover moved into B1 and `VendorVectorStore`
died with B2.

- Stripe checkout + customer portal + webhook → the `plan` column the weekly cap
  already reads.
- Blocked on a pricing decision, not on code.

**Exit:** a stranger can pay, sign in, and use remote mode + agent — with no
customer content in vendor storage at all.

---

## Phase 4 — Commercial launch (CONVERGE, medium)

Everything needed to charge money with confidence. Requires P2 + B3.

| # | Item | Scope |
|---|---|---|
| 4.1 | A8 prompt caching | stable system+tools+repo-map prefix; measure hit rate |
| 4.2 | D4 cost display | per-run tokens/cost in the agent panel |
| 4.3 | G1 pricing + quotas | Free (local+BYOK-limited) / Pro ~$20 / Team; token-metered (open item: quota unit) |
| 4.4 | D2 BYOK tier | user's own frontier key through our harness |
| 4.5 | G3 evals at 50 tasks | gate: agent-mode GA only above the pass-rate bar; decides frontier-model routing (open item 3) |
| 4.6 | F3 + F4 | data-flow one-pager for security reviews; ToS/privacy copy; load/abuse test (SaaS step h) |
| 4.7 | G4 launch | docs site, demo video published, marketplace listing rewrite, Open VSX + fork deeplinks verified |

**Exit:** public paid launch. Local mode free forever; remote mode = the
subscription.

---

## Phase 5 — Parity & depth (AGENT, ongoing)

Post-launch, priority-ordered by user feedback; each item independent.

| # | Item |
|---|---|
| 5.1 | E2 inline edit (⌘K) — first, highest value-to-cost |
| 5.2 | C3 MCP client support |
| 5.3 | E4 agent session resume (tool-call transcripts + checkpoints) |
| 5.4 | A10 sub-agents / background tasks |
| 5.5 | C4 deploy-loop agent tools (`release-core` behind approval gates) |
| 5.6 | D3 local-mode agent tuning + honest capability labels — leans on skills (2.9/3.6): recipe-driven small-model workflows |
| 5.7 | Skills phase 2: descriptions listing + `load_skill` tool ([SKILLS-DESIGN.md](SKILLS-DESIGN.md) step 5) |

---

## Track X — General product UX (ungated, ongoing)

Not part of the Cursor/Claude Code competitive wedge — no phase depends on
these and none block on them. Logged here so this doc stays the single record
of shipped work, not just the agent-pivot track.

| # | Item | Shipped |
|---|---|---|
| X.1 | Chat message editing + backend history rewrite | 2026-08-24 |
| X.2 | Sidebar auto-collapse when dragged below minimum width | 2026-08-24 |
| X.3 | Collapsible Settings sections (`SectionShell`) with persistent state + status summaries | 2026-08-25 |

---

## Sequencing rules

1. **Never ship execute (P2) before the trust UI (P1) exists.**
2. **B1 starts as soon as P1 starts** — agent dev should dogfood the proxy,
   not bolt it on later.
3. **P3 before P4**: launch marketing needs the moat demo, not just parity.
4. **Evals gate GA** (4.5): agent mode stays "beta" until the pass-rate bar.
5. Any phase can pause after its exit — every exit state is releasable.
