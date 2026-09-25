# WorkspaceGPT — Deployment Automation (Design)

> Status: **Built** (config-sync + hotfix: `packages/release-core`, `apps/vscode-extensions/src/services/deployment/`) · Owner: Ritesh · Design last updated: 2026-06-19; §12 folded in 2026-09-25
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
| Conventional Commits for component identity | scoped monorepo tag prefixes, `hotfix.N`, `D2C-` ticket prefixes |
| Cherry-pick → tag → release triggers deploy | Specific GitHub workflows; AWS/layer0 deploy |
| Issue tracker integration | Tracker = Azure DevOps |

Tight coupling = the engine "knowing" about Confluence tables or org-specific
tag formats. The fix is the adapter architecture below.

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
   config vars. Parsing mode is configurable per source: deterministic header
   matching with the LLM as a fallback normalizer, or — via the **Always use AI
   for config sync** option — LLM-always, since release-page layouts vary too
   much per-org for header matching to be reliable. Either way the AI output is
   validated deterministically and still gated by the plan→approve review.
   Output = the *desired* half of the Plan; still touches nothing live.
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
| c | Read/extract: `ConfluenceRosterSource`, `ConfluenceReleasePageSource`, table parser | Open item #2 | **resolve done** — `ConfluenceReleaseSource` (`resolveRelease` wired to the Releases view; `fetchDesiredConfig` implemented with default target/env mapping pending open items #2/#3); digit-preserving `parseStorageTables` in `confluence-utils`; 14 parse assertions green |
| d | Diff/apply: `VercelTarget`, `GitRepoTarget`, approval gate UI | Open items #1, #3, #4 | **Vercel half DONE (end-to-end)** — preview → `Plan against live Vercel` (diff) → `Approve & apply` (`APPLY_CONFIG_SYNC`): server recomputes plan, conflict-gated, applies add/update via `VercelTarget.apply` (idempotent upsert; custom-env aware), per-var results + **Retry failed**, writes `FileAuditLog` (globalStorage `deployment-runs.jsonl`) → **Recent runs**. Settings: live Vercel project dropdown + Stage/Prod→env mapping. Platform limits handled: custom-environment vars (`customEnvironmentId`), `Global Project Environment Variables` scope required, and integration tokens **can't decrypt** values → present=opaque `update`. Debug stripped. **mach split into two facets of the `mach` target: `MachSyncTarget` (component-version promotion via the sync workflow — dispatches, finds run/PR, `readDestFile`/`commitDestFile`, done) and `MachEnvTarget` (`ConfigTarget` for `main.yml` env vars — `readCurrent` reads `main.yml` at the latest open sync PR head via `findLatestSyncPull`, diffs Confluence-desired vs it, `apply` commits corrections to the same PR branch as one idempotent commit).** **Now WIRED end-to-end** — `PLAN_MACH_ENV`/`APPLY_MACH_ENV` handler methods (share `buildMachEnvPlan`; `NoSyncPrError` → `needsSync` prompt rather than a hard error; server-side plan recompute + conflict-gate + `applicableChanges` + Retry-failed + audit log, mirroring the Vercel apply) and a "main.yml env vars" sub-block in the Releases mach section (Plan → `PlanReview` diff + PR link → "Commit env vars to PR"). Uses a **default `MainYmlCodec`** (`mainYmlCodec.ts`: flat top-level `KEY: value`, dotted keys, surgical line edits, append-if-absent — sanity-tested) that stays swappable once the real `main.yml`/`update-main-file/action.yml` schema is confirmed. Order inverts Vercel's: mach sync (opens PR) → env diff against the PR → approve → commit to PR → human merge. |
| e | Hotfix flow (see §9) | after config-sync is solid | **DONE (end-to-end, pending live e2e)** — org-agnostic core `buildHotfixPlan` + Conventional-Commit scope→component mapping + tag/branch formatting in `release-core` (`hotfix/plan.ts`, 17 unit tests green); `GitHubVcsProvider` adapter (`src/services/deployment/githubVcsProvider.ts`, mach PAT) does commit-search-by-ticket, Git-Data-API cherry-pick (sibling→merge→reparent, conflict-safe), idempotent annotated tag + GitHub Release; handler `PLAN_HOTFIX`/`APPLY_HOTFIX` (find commits → derive base version + next `hotfix.N` from existing tags → plan; apply recomputes server-side, cherry-picks onto the hotfix branch, tags+releases per component, audit log); Releases view has a magenta hotfix pipeline card (tickets → Plan → per-component review with manual base-version entry when no tag exists → Approve & apply → release links + Retry failed). |
| f | MCP action-tools + decoupling audit (no org strings in `release-core`) | after d | not started |

### What's been built (initial increment)

- **`packages/release-core`** — `ReleasePlan`/adapter types ([types.ts](../../packages/release-core/src/types.ts)),
  deterministic diff engine ([diff.ts](../../packages/release-core/src/plan/diff.ts)),
  plan builder, idempotent apply with conflict-gate + partial-success
  ([applyPlan.ts](../../packages/release-core/src/apply/applyPlan.ts)), in-memory +
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

## 9. Hotfix flow (BUILT)

Reuses the same resolve → extract → diff → approve → apply spine, with
tickets/commits/tags instead of config vars:

1. Collect hotfix ticket numbers.
2. Find GitHub commits whose title carries the ticket (`D2C-…`).
3. Conventional-Commit scope → which component to fix (`feat(mms-bff): …`).
4. Cherry-pick onto a `hotfix/<date>` branch.
5. Push tag `<component>-vX.Y.Z-hotfix.N` (org-specific tag format); create a GitHub Release from
   the tag → deploy workflow fires (+ manual `[deploy] Service (S3 serverless)`
   step for lambda components).

### How it's implemented (mirrors the config-sync spine)

- **Org-agnostic core** — `packages/release-core/src/hotfix/plan.ts`:
  `buildHotfixPlan` is pure (no network, no clock). It groups the commits an
  adapter supplies by component, assigns the next `hotfix.N` and renders the tag
  per component, and surfaces any commit with no derivable component in
  `unassigned` (never dropped silently). Component mapping defaults to the
  Conventional-Commit scope (`parseConventionalCommit`); the tag template
  (`{component}-v{version}-hotfix.{n}` by default) and the
  commit→component rule are both injectable. When a component's base version is
  unknown the tag is `null` — the reviewer supplies it; the engine never invents
  a version. 17 unit tests green.
- **VCS adapter** — `src/services/deployment/githubVcsProvider.ts` implements
  the `VcsProvider` seam over the GitHub REST API with the mach classic PAT
  (`repo` scope covers commit-search, git-data writes, tags and releases,
  including the SAML-SSO'd Mars orgs). GitHub has no cherry-pick endpoint, so
  `cherryPick` replays the Git-Data-API algorithm per commit
  (sibling-commit → `/merges` → reparent → fast-forward); a merge conflict
  surfaces as an error and restores the branch head rather than writing a bad
  tree. `createTag`/`createRelease` are idempotent (existing tag left in place;
  existing release fetched), so Retry is safe. `listTags(prefix)` drives base
  version + existing-`hotfix.N` derivation.
- **Handler** — `PLAN_HOTFIX` finds commits per ticket, derives each component's
  base version + taken hotfix ordinals from tags, and returns the plan.
  `APPLY_HOTFIX` recomputes the plan server-side (never trusts the client),
  blocks any component still missing a base version, cherry-picks the
  de-duplicated commit set onto the hotfix branch, then tags + releases each
  component, recording per-component + run-summary audit entries.
- **UI** — a magenta hotfix pipeline card in the Releases view: paste tickets →
  Plan (per-component commit list + proposed tag, with an inline base-version
  input when no released tag exists) → Approve & apply → release links + Retry
  failed. Config (hotfix repo owner/repo/branch, tag template) defaults from the
  mach workflow-dispatch action's repo topology, overridable via a
  `pipeline.hotfix` block.

Pending: live end-to-end verification against the real component repo; the
manual `[deploy] Service (S3 serverless)` step for lambda components is not
automated (the tag/release fires the standard deploy workflow only).

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
| 1 | mach repo: exact config **file path + format**, and **branch-protection rules** | Builds `GitRepoTarget`; decides merge vs PR-only | **Resolved (below).** File = `main.yml` env vars in the destination repo; `components.yml` = component versions (separate axis). **`current` is read at the head of the latest open sync PR, not `main`** — the sync workflow's PR carries the release's `main.yml`/`components.yml`, so that PR is both the diff source and the write target. Branch-protection → PR-only, never auto-merge to `stage`. Remaining unknown: the exact `main.yml` env-var schema → injected `MainYmlCodec`. |
| 2 | Configurations-table **mapping rule**: which `App/System` values → Vercel vs mach (e.g. `Vercel` → Vercel, everything else → mach?) | The parser's core contract | _TBD_ |
| 3 | **Stage/Prod → Vercel environment** mapping (production / preview / custom "stage") | Otherwise writes to the wrong env | _TBD_ |
| 4 | Vercel **team/project** the integration installs into | Scopes the integration | _TBD_ |

---

## 12. Connection setup

How to connect the write-scoped providers used by the deployment-automation
feature: **GitHub (OAuth App)** and **Vercel (OAuth integration)**. These
credentials live only in the VS Code master and are never shared to the Chrome
extension. The rest of this doc is the design.

There are three steps per provider: **register the app**, **put the secret on
the proxy**, **paste the public id into the extension**.

---

### 12.1 GitHub — OAuth App (active path)

The "Authorize WorkspaceGPT" consent flow.

**Register:** GitHub → Settings → Developer settings → **OAuth Apps** → *New OAuth App*
- **Application name:** `WorkspaceGPT Deploy`
- **Homepage URL:** any (the mach repo URL is fine)
- **Authorization callback URL:** `http://127.0.0.1:32325/callback`
  *(must match `GITHUB_OAUTH.CALLBACK_PORT` in constants)*
- *(optional)* enable token expiration if you want refresh tokens

→ gives a **Client ID** and **Client Secret**.

> Note: scopes are coarse — `repo` grants write to all repos you can access, and
> commits/PRs are authored as **you**. Org owners can require approval for OAuth
> apps (one click), but there's no private key or install flow. For per-repo
> scoping or bot identity, see the GitHub App mode in §4.

**Proxy env** (the `confluence-auth-proxy` Vercel project → Settings → Environment Variables):
```
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
```

**Extension** (`apps/vscode-extensions/constants.ts`):
```ts
GITHUB_OAUTH.CLIENT_ID = '<client id>'
```

---

### 12.2 Vercel — OAuth integration

**Register:** Vercel → account menu → **Integrations Console** → *Create*
(`vercel.com/dashboard/integrations/console`), OAuth2 / Developer integration.
- **Name / slug:** e.g. `workspacegpt-deploy`
- **Redirect URL:** `http://127.0.0.1:32326/callback`
  *(must match `VERCEL_OAUTH.CALLBACK_PORT`)*
- **Access:** read & write to **Environment Variables** on the projects selected
  at install time

→ gives a **Client ID** and **Client Secret**.

> ⚠️ Vercel may reject a non-HTTPS `http://127.0.0.1` redirect URL. If it refuses
> to save it, we need a small HTTPS redirect endpoint on the proxy that bounces
> back to the loopback server — ask and it'll be added.

**Proxy env:**
```
VERCEL_CLIENT_ID=...
VERCEL_CLIENT_SECRET=...
```

**Extension** (`constants.ts`):
```ts
VERCEL_OAUTH.CLIENT_ID        = '<client id>'
VERCEL_OAUTH.INTEGRATION_SLUG = 'workspacegpt-deploy'
```

---

### 12.3 Deploy & test

1. **Redeploy the proxy** so it picks up the new env vars:
   ```
   cd apps/confluence-auth-proxy && vercel --prod
   ```
2. **Rebuild the extension** and reload it:
   ```
   pnpm --filter workspacegpt-extension build
   ```
3. In VS Code: Settings → **Deployment Automation** → toggle on → **Connect** on
   each provider. The browser opens the Authorize screen, redirects to the
   loopback server, and the card flips to ✅.
4. Hit **Test all connections** — it makes a real API call with each token
   (`GET /user` on GitHub, `/v2/user` on Vercel), so green means the whole chain
   (proxy secret → token → API) actually works.

Until the ids above are set, the Connect buttons throw a clear
*"not configured yet"* error by design.

---

### 12.4 Optional: GitHub App mode (hardening)

If you later want **bot identity + per-repo scoping + short-lived (1h) tokens**
instead of the OAuth App, the code retains a GitHub App path behind the same
token interface:

- Register a GitHub App (Callback URL `http://127.0.0.1:32325/callback`, enable
  "Request user authorization during installation", permissions Contents +
  Pull requests + Actions R/W). Generate a private key.
- Proxy env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (base64 PEM) — see the
  proxy `.env.example`.
- Extension: set `GITHUB_APP.APP_SLUG`, and switch `DeploymentMessageHandler` to
  use `GitHubAppAuthService` instead of `GitHubOAuthService`.

Heavier setup (private key, install flow, likely org-admin approval) — not the
default.
