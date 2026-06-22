# WorkspaceGPT — Deployment Automation (Design)

> Status: **Draft for review** · Owner: Ritesh · Last updated: 2026-06-19
>
> First of the "enterprise" features. Goal: automate the release-deployment toil
> that today is done by hand against Confluence, Vercel, and the mach repo —
> **without coupling WorkspaceGPT to one organisation's process.**

---

## 1. Problem

Each release, a pilot manually:

1. Looks up **today's release version** on the Confluence *Release Roster*.
2. Opens that release's Confluence page.
3. Reads the **Configurations table** (env vars / feature flags, with separate
   Stage and Production values).
4. Checks whether each variable already exists in the target system; if present,
   validates the value; if absent, adds it.
5. Does this across **two systems**: **Vercel** (frontend) and the **mach repo**
   (backend).

(Version bumps themselves are already automated by an existing GitHub workflow
that opens a PR — so this feature targets the **config-sync** toil above.)

There is a second, separate flow — **hotfix deployment** (cherry-pick by ticket
→ tag → GitHub release) — covered in §9 as a later milestone.

---

## 2. Design principles

1. **Decouple the engine from the organisation.** The core knows only generic
   concepts (release, environment, config variable, target, diff, apply). All
   Mars/D2C specifics live in *adapters* and *config*, never in the engine.
   Litmus test: *could another org adopt this without editing the core?*
2. **The LLM reads and normalises; deterministic code decides and executes.**
   The model turns a messy Confluence table into structured facts. It never
   decides to write to prod. For anything touching prod, the non-deterministic
   part does not hold the pen.
3. **Plan → approve → apply → verify**, terraform-style. Always produce a
   reviewable diff; require explicit human approval; apply idempotently; log
   every action.
4. **Read and write credentials are separated.** Deploy tokens are
   write-scoped, VS-Code-only, and **never** enter the Chrome share bundle.

---

## 3. Is this a "standard" release process?

The **shape** is industry-standard; the **bindings** are Mars/D2C-specific. That
split *is* the decoupling seam.

| Standard primitive (model generically) | Mars/D2C binding (isolate in an adapter) |
|---|---|
| Release-train cadence (calendar → version) | Source of truth = Confluence pages with a specific table layout |
| Config promotion stage → prod, semver | Two targets: Vercel + a MACH git repo |
| Conventional Commits for component identity | `@phoenix/…`, `@terraform/…&depth=1`, `hotfix.N`, `D2C-` prefixes |
| Cherry-pick → tag → release triggers deploy | Specific GitHub workflows; AWS/layer0 deploy |
| Issue tracker integration | Tracker = Azure DevOps |

Tight coupling = the engine "knowing" about Confluence tables or `@phoenix`
tags. The fix is the adapter architecture below.

---

## 4. Architecture

### 4.1 The pivot — a normalized "Release Plan"

Everything upstream parses **into** it; everything downstream acts **from** it.
It is also the human-review checkpoint. Nothing reads a Confluence page and
writes Vercel directly — it always goes through the Plan.

```
   SOURCES (where truth lives)            THE PIVOT                TARGETS (where it lands)
 ┌──────────────────────────┐                                   ┌─────────────────────────┐
 │ Confluence Roster page    │──┐                            ┌──▶│ Vercel  (frontend env)  │
 │  date → release version   │  │       ┌──────────────┐     │   ├─────────────────────────┤
 ├──────────────────────────┤  ├─ READ▶│ RELEASE PLAN │─DIFF┼──▶│ mach repo (backend env) │
 │ Confluence Release page   │──┘       │ (structured, │     │   └─────────────────────────┘
 │  config table + versions  │          │  reviewable) │     │
 └──────────────────────────┘          └──────┬───────┘     └── reads CURRENT state to diff
                                                │
                                          HUMAN APPROVES
                                                │
                                          APPLY (idempotent)
```

`ReleasePlan` (sketch):

```jsonc
{
  "release": "mms-2026-6.2-rc.6",
  "environment": "stage",
  "configVars": [
    { "key": "...", "target": "vercel", "current": null, "desired": "true", "action": "add" },
    { "key": "...", "target": "mach",   "current": "true", "desired": "false", "action": "conflict" }
  ]
  // hotfix block (tickets[], commits[], tags[]) added in the later milestone
}
```

`action ∈ { add, update, match, conflict }`. `conflict` = present but the live
value disagrees with the page → surfaced loudly, never silently overwritten.

### 4.2 Pluggable adapters around a deterministic core

| Family | Interface | v1 implementation | Org-specific knowledge it hides |
|---|---|---|---|
| Source | `ReleaseSource` | `ConfluenceRosterSource`, `ConfluenceReleasePageSource` | table columns, roster layout |
| Config target | `ConfigTarget` | `VercelTarget`, `GitRepoTarget` (mach) | API shape, file format/path |
| VCS | `VcsProvider` | `GitHubVcs` | repo names, tag/branch naming |
| Tickets | `TicketProvider` | `AzureDevOpsTickets` | `D2C-` prefix, query format |

Org-specific values (which columns, which tag regex, which repo) are
**configuration the adapter reads**, not logic in the engine.

### 4.3 Where it lives

- **VS Code extension ("master")** — full credentials and the write authority.
  The deployment engine and write tokens live here. **Not Chrome** (read-only
  consumer; keys-in-bundle to a browser is wrong for write tokens).
- **MCP server** — later, expose `resolve_release` / `plan_config_sync` /
  `apply_config_sync` as action-tools alongside the existing search tools.
- **`packages/release-core`** — new org-agnostic package consumed by both.

---

## 5. The flow (normal config-sync)

1. **Resolve** — read Roster page, match today's date → version + env.
   Deterministic lookup; touches nothing live.
2. **Extract** — parse the release page's Configurations table into structured
   config vars (deterministic parse; LLM only as a fallback normalizer for
   malformed rows). Output = the *desired* half of the Plan; still touches
   nothing live.
3. **Diff** — read *current* state from Vercel + mach; classify every var as
   add / update / match / conflict. Result reads like `terraform plan`.
4. **Approve → Apply** — human approves the diff; only then write. Apply is
   **idempotent** (re-running a satisfied plan is a no-op), so a retry after a
   partial failure finishes the job rather than doubling up. Every action logged.

The human's role shifts from *doing the work* to *approving the diff*.

---

## 6. UI design

Fits inside the **existing WorkspaceGPT sidebar shell** (one React webview,
title-bar icons). One new shell piece: a full-width **editor-area panel** for the
diff (the sidebar's ~300px is too narrow for tabular current→desired data;
VS Code's own idiom is sidebar-to-navigate, editor-area-for-content).

**Four surfaces:**

1. **Releases home (sidebar).** New rocket icon switches the React app to a
   Releases view: a "Today's release" card (resolved version + env + pilot from
   the roster) with a *Prepare config sync* button, and recent runs with status
   badges.
2. **Plan Review (editor panel) — the heart.** Diff grouped by target
   (Vercel / mach); each row labelled add/update/match/conflict; summary chips
   (12 add · 3 update · 40 match · 1 conflict); a persistent
   **"Dry run — nothing applied"** badge. The **Approve & apply** button stays
   *disabled until conflicts are acknowledged* — given auto-apply, this screen is
   the entire safety mechanism, so the blast radius must be unmissable. Match
   rows shown but de-emphasised so the eye goes to what changes.
3. **Apply result (same panel).** Partial success is first-class: per-target,
   per-variable outcome (e.g. `14/15`), failures isolated, **"Retry failed"**
   re-runs only unfinished work (idempotent). One-click to the audit log.
4. **Settings → Deployment.** Connect GitHub App / Vercel / mach path; status
   badges; "Test all connections" (find a dead token at 2pm, not mid-deploy).
   Subtitle states write creds are separate from read keys and never in the
   Chrome share bundle.

The UI is org-agnostic too: it only knows "targets" and "config rows with
actions." Swap Vercel/mach for Doppler/Parameter-Store and the panel renders
unchanged — only the group labels come from adapters.

---

## 7. Authentication (OAuth/proxy, mirroring Confluence)

Reuse the existing pattern: a temporary `127.0.0.1:<port>/callback` server in
VS Code + a server-side secret-keeper (the Vercel proxy) so no secret ships in
the extension bundle. Tokens stored in VS Code `SecretStorage`. Generalise
`apps/confluence-auth-proxy` → **`auth-proxy`** with one endpoint per provider,
each holding only its own secret. One `OAuthService` base, thin subclasses.

### GitHub — **OAuth App** ("Authorize" flow), active path

Identical in shape to the Confluence OAuth flow (least new code): open the
authorize URL → capture `code` on the loopback callback → exchange via the proxy
(`/api/github/oauth-token`, holds `client_secret`) → user access token in
`SecretStorage`. No private key, no install dance. Refresh supported if the
OAuth App enables token expiration.

Trade-offs accepted: scopes are coarse (`repo` = write to all the user's repos)
and actions are authored as the **user**, not a bot. Under branch protection,
backend **"auto-apply" = auto-open a PR**, never auto-merge.

#### Optional hardening: GitHub App mode

Retained behind the same "give me a GitHub token" seam for teams that later want
**bot identity + per-repo scoping + short-lived (1h) minted tokens**. There the
"connect" is an *install* (callback captures `installation_id`) and the proxy
mints tokens from the App **private key** via `/api/github/installation-token`.
Heavier setup; not the default.

### Vercel — OAuth Integration

First-class OAuth; the flow returns a token scoped to the chosen team/project.
Clean mirror of Confluence. (Nuance: integration tokens are long-lived per
install rather than refresh-rotated — different lifecycle, same plumbing.)

### Confluence / ADO — reused

Already connected for RAG; the deployment feature borrows that auth. Only the
new targets (GitHub App, Vercel, mach path) need setup.

---

## 8. Build order

| Step | Deliverable | Blocked by | Status |
|---|---|---|---|
| a | proxy endpoints + GitHub-App install flow + Vercel OAuth + `SecretStorage` wiring + Settings UI | nothing (fully specified) | **done** (type-checks + webview builds; needs provider registration to connect) |
| b | `packages/release-core`: `ReleasePlan` schema + adapter interfaces + audit log | nothing | **done** (type-checks + 8 unit tests green) |
| c | Read/extract: `ConfluenceRosterSource`, `ConfluenceReleasePageSource`, table parser | Open item #2 | not started |
| d | Diff/apply: `VercelTarget`, `GitRepoTarget`, approval gate UI | Open items #1, #3, #4 | not started |
| e | Hotfix flow (see §9) | after config-sync is solid | not started |
| f | MCP action-tools + decoupling audit (no org strings in `release-core`) | after d | not started |

### What's been built (initial increment)

- **`packages/release-core`** — `ReleasePlan`/adapter types ([types.ts](packages/release-core/src/types.ts)),
  deterministic diff engine ([diff.ts](packages/release-core/src/plan/diff.ts)),
  plan builder, idempotent apply with conflict-gate + partial-success
  ([applyPlan.ts](packages/release-core/src/apply/applyPlan.ts)), in-memory +
  JSONL audit logs. 8 unit tests pass.
- **Auth (step a) — proxy + services + UI, end-to-end.** Added
  `/api/github/installation-token` (mints GitHub-App installation tokens via
  native-crypto RS256 JWT — no new proxy deps) and `/api/vercel/token` to the
  **existing** `confluence-auth-proxy` app (rather than renaming it, so the live
  Confluence token URL keeps working). VS Code side: shared `OAuthCallbackServer`
  + `GitHubAppAuthService` + `VercelAuthService` (write creds in `SecretStorage`),
  a `DeploymentMessageHandler` wired into the dispatch chain, and a **Settings →
  Deployment** React section (connect/disconnect GitHub + Vercel, "Test all
  connections"). Constants + storage keys + message types + store `deployment`
  section added. Extension + webview both type-check; webview bundles.

### Provider registration the user must do before connect works

- Set `GITHUB_APP.APP_SLUG` and `VERCEL_OAUTH.{CLIENT_ID,INTEGRATION_SLUG}` in
  `apps/vscode-extensions/constants.ts`.
- Proxy env vars (see proxy `.env.example`): `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY` (base64 PEM), `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`.
- GitHub App: Callback URL `http://127.0.0.1:32325/callback`, enable "Request
  user authorization (OAuth) during installation"; Vercel redirect URL
  `http://127.0.0.1:32326/callback`.

- **Releases home (sidebar) — navigable shell.** New rocket title-bar icon →
  `workspacegpt.releases` command → `SHOW_RELEASES` → a `Releases` overlay
  (same pattern as Settings/History). Shows "Today's release" + "Recent runs",
  driven by a `RESOLVE_RELEASE`/`GET_RELEASE_RUNS` round-trip to the handler.
  The handler currently returns a stub (`configured: false`) so the view renders
  an honest empty state with a disabled "Prepare config sync" — the real
  `ReleaseSource` swaps in at step c. Extension + webview type-check; webview
  bundles.

Open items #1–#4 (below) gate the diff/apply half of steps c/d, not a/b or the
Releases shell.

---

## 9. Hotfix flow (later milestone)

Reuses the same resolve → extract → diff → approve → apply spine, with
tickets/commits/tags instead of config vars:

1. Collect hotfix ticket numbers.
2. Find GitHub commits whose title carries the ticket (`D2C-…`).
3. Conventional-Commit scope → which component to fix (`feat(mms-bff): …`).
4. Cherry-pick onto a `hotfix/<tag>` branch.
5. Push tag `@phoenix/<component>-vX.Y.Z-hotfix.N`; create a GitHub Release from
   the tag → deploy workflow fires (+ manual `[deploy] Service (S3 serverless)`
   step for lambda components).

---

## 10. Decisions log

| Decision | Choice | Date |
|---|---|---|
| Autonomy | **Plan → approve → auto-apply** (human approves in-app, then it writes; backend = open PR under branch protection) | 2026-06-19 |
| v1 scope | **Normal deploy / config-sync first** | 2026-06-19 |
| Config-source reliability | **Consistent table layout** → deterministic parse, LLM fallback | 2026-06-19 |
| GitHub auth model | **GitHub OAuth App** ("Authorize" flow, secret on proxy, acts-as-user) — chosen for low setup friction. GitHub App (bot identity, per-repo, minted tokens) retained as an optional hardening mode behind the same token interface. | 2026-06-19 |
| App registration ownership | **User registers** the GitHub App + Vercel Integration, provides secrets | 2026-06-19 |
| Client surface | **VS Code only** (master); write creds excluded from Chrome share bundle | 2026-06-19 |

---

## 11. Open items (gather in parallel; do not block steps a–b)

| # | Needed | Why it matters | Answer |
|---|---|---|---|
| 1 | mach repo: exact config **file path + format**, and **branch-protection rules** | Builds `GitRepoTarget`; decides merge vs PR-only | _TBD_ |
| 2 | Configurations-table **mapping rule**: which `App/System` values → Vercel vs mach (e.g. `Vercel` → Vercel, everything else → mach?) | The parser's core contract | _TBD_ |
| 3 | **Stage/Prod → Vercel environment** mapping (production / preview / custom "stage") | Otherwise writes to the wrong env | _TBD_ |
| 4 | Vercel **team/project** the integration installs into | Scopes the integration | _TBD_ |
