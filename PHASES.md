# WorkspaceGPT — Master Phase Plan

> Status: **Canonical sequencing** · Owner: Ritesh · Last updated: 2026-08-15
>
> One place that orders ALL planned work. Merges the build orders from
> [CODING-AGENT-ROADMAP.md](CODING-AGENT-ROADMAP.md) (items A1–G5) and
> [REMOTE-MODE-SAAS-DESIGN.md](REMOTE-MODE-SAAS-DESIGN.md) (steps a–h).
>
> **Status (2026-08-15):** P0 ✅ (0.1 matrix still finishing on qwen; shadow-git
> decided). **P1 ✅ code-complete** — write tools + diff-review cards +
> checkpoints/revert command + diagnostics + git read tools, all building.
> **P2 core ✅** — run_command (denylist → approval → execute), session
> allowlist, agent-actions.jsonl audit, rules-files injection (.workspacegpt/
> rules.md, CLAUDE.md, .cursorrules, AGENTS.md). **P3.1 ✅** — search_docs /
> search_tickets exposed as agent tools. Remaining: P2.4/2.5 worker hardening
> & context mgmt, P2.8 git write tools, P3.2–3.5, E3 real-terminal capture;
> B1–B3/P4 blocked on AWS + Stripe accounts. All pending live manual testing
> in the Extension Development Host.
> Those docs own the *what/why*; this doc owns the *when*. Each phase is a
> shippable cut-line: if work stops after any phase, the product is still
> better and releasable.

**Two tracks run in parallel:**
- **AGENT track** — extension work (the product).
- **BACKEND track** — AWS SaaS work (the business). Independent codebase
  (`apps/workspacegpt-api`), can proceed alongside any agent phase.

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

**Exit demo:** point the agent at a failing test; it reads the failure, fixes
the code, reruns the test to green, commits on approval — with every command
visible and every action audited. Marketplace-quality "agent mode (beta)".

**Out:** codebase RAG, org tools, sub-agents.

---

## Phase 3 — The moat: "it knows your org" (AGENT, medium)

Differentiation on top of a working agent. This phase is the marketing.

| # | Item | Scope |
|---|---|---|
| 3.1 | C1 org tools in agent | `search_docs` / `search_tickets` / `read_page` / `get_ticket` from existing RAG |
| 3.2 | B5 @-mentions | files, symbols, Confluence pages, ADO tickets in one mention model |
| 3.3 | B1 codebase RAG revival | dormant jina-code path: incremental, hash-skipped, gitignore-aware; semantic `search_code` tool |
| 3.4 | B2 repo map | `buildRepoOrientation` + LSP symbols, import-graph ranked, in the cached prompt prefix |
| 3.5 | C2 ticket→PR flow | "implement D2C-1234" end-to-end; record the 3-minute demo (G4) |

**Exit:** the demo video exists and is reproducible on a fresh repo; G5 (X
pipeline) starts posting agent demos.

**Decision due here:** SaaS open item — remote-mode code indexing via vendor
embedding vs local-even-in-remote (roadmap open item 4).

---

## Backend B1 — Managed chat proxy (BACKEND, medium) · *start during P1*

SaaS steps **a** (+ half of h). The smallest sellable backend slice.

- `apps/workspacegpt-api`: entitlement middleware, DynamoDB tenants/usage,
  SSM provider keys, `/v1/chat` via Lambda Function URL streaming — **with
  tool-call passthrough + prompt-cache headers from day one (D1)**, since the
  agent is the main consumer.
- Logging discipline (no bodies in CloudWatch) + CI lint from the start.
- AWS Budgets alarm.

**Exit:** the extension's remote mode can run the P1/P2 agent through the
proxy with a hand-issued API key. Agent development now dogfoods the proxy.

## Backend B2 — Managed index (BACKEND, medium)

SaaS steps **b–d** (b already done in Phase 0.3).

- `/v1/upsert` `/v1/search` `/v1/chunks` on the chosen vector store;
  per-tenant indexes; contentHash skip.
- `packages/vendor-client`: typed API client + AES-256-GCM encrypt/decrypt.

**Exit:** a test tenant syncs Confluence through the vendor path; payloads at
rest verifiably ciphertext; deletion propagates.

## Backend B3 — Client cutover + billing plumbing (BACKEND, medium)

SaaS steps **e–g**.

- VS Code remote-mode refactor: subscription-key settings, `VendorVectorStore`,
  legacy re-sync migration prompt; delete client-side `REMOTE_TASK_MODELS`.
- Chrome: share bundle v3 `{apiKey, tenantId, contentKey}`, local decryption.
- Stripe checkout + customer portal + webhook → entitlement.

**Exit:** a stranger can pay, get a key, sync, and use remote mode + agent
with zero vendor-readable data at rest.

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
| 5.6 | D3 local-mode agent tuning + honest capability labels |

---

## Sequencing rules

1. **Never ship execute (P2) before the trust UI (P1) exists.**
2. **B1 starts as soon as P1 starts** — agent dev should dogfood the proxy,
   not bolt it on later.
3. **P3 before P4**: launch marketing needs the moat demo, not just parity.
4. **Evals gate GA** (4.5): agent mode stays "beta" until the pass-rate bar.
5. Any phase can pause after its exit — every exit state is releasable.
