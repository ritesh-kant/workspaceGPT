# WorkspaceGPT — Remote Mode on Cloudflare (as built)

> Status: **Implemented** · Owner: Ritesh · Last updated: 2026-08-31
>
> This describes what is in the tree, not a proposal. It replaces the lost
> original of this file and supersedes the AWS/managed-index plan in
> [REMOTE-MODE-SAAS-DESIGN.md](REMOTE-MODE-SAAS-DESIGN.md) for everything about
> how remote mode works today.

---

## 1. What remote mode is

One thing: **where chat inference comes from.**

| | **Local** | **Remote** |
|---|---|---|
| Chat model | Bring your own (Ollama, OpenAI, Gemini, OpenRouter…) | WorkspaceGPT's managed model |
| Model keys the user handles | Their own | **None** |
| Account | None | **Required** — GitHub sign-in |
| Embeddings | Bundled local ONNX | **Bundled local ONNX (identical)** |
| Vector index | Local file store | **Local file store (identical)** |
| What leaves the machine | Whatever their chosen provider sees | The question + retrieved snippets, in flight only |

The deliberate asymmetry: remote mode sells **the model**, not the index.
Indexing is untouched by the mode switch, so switching modes never invalidates
an index, never triggers a re-sync, and never asks the user for an embedding
provider key. `getEmbeddingSettings` and `getVectorStoreSettings` therefore
return `local` unconditionally and no longer read `getMode` at all.

Consequence, accepted: **Share-to-Chrome is parked.** The Chrome extension
reads the vector index directly, and a file-based index on one person's
machine is not reachable from someone else's browser. The action is hidden
(`EXTENSION.CONTEXT_SHARE_ENABLED`, always `false`) and `shareToChrome()`
explains why instead of asking for Gemini/Qdrant settings the mode switch no
longer exposes. The v2 bundle code is left intact for the day a hosted index
exists.

---

## 2. Architecture

```
 VS CODE EXTENSION                   CLOUDFLARE WORKER                    UPSTREAM
┌───────────────────────────┐      ┌──────────────────────────────┐   ┌──────────────┐
│ Confluence / ADO / code   │      │ workspacegpt-api             │   │ GitHub OAuth │
│  sync + chunk + embed     │      │                              │◀─▶│  (read:user) │
│  → LOCAL index (always)   │      │ control plane                │   └──────────────┘
│                           │      │  GET  /auth/login            │
│ retrieval → prompt        │      │  GET  /auth/github/callback  │   ┌──────────────┐
│                           │      │  GET  /v1/me                 │   │ OpenRouter   │
│ new OpenAI({              │─────▶│  POST /auth/logout           │──▶│ (vendor key) │
│   baseURL: API_BASE/v1,   │      │                              │   └──────────────┘
│   apiKey: sessionToken }) │      │ data plane                   │
│                           │◀─────│  POST /v1/chat/completions   │
└───────────────────────────┘ SSE  │                              │
                                   │ KV: SESSIONS                 │
                                   │ D1: users · usage_weekly ·   │
                                   │     app_config               │
                                   └──────────────────────────────┘
```

### Why an OpenAI-compatible proxy

Every provider in the extension is reached through
`new OpenAI({ apiKey, baseURL })` ([modelWorker.ts](apps/vscode-extensions/src/workers/model/modelWorker.ts)).
Making the Worker speak `POST /v1/chat/completions` means remote mode is that
same client pointed at a different base URL — so streaming, the tool-calling
agent loop, and key failover all keep working with **no new transport**. The
client-side change is one branch in
[getLlmSettings.ts](apps/vscode-extensions/src/utils/getLlmSettings.ts).

---

## 3. Sign-in flow

The Worker mediates the whole GitHub round-trip; the extension never sees a
GitHub token.

1. Extension opens a loopback callback server on `127.0.0.1:32329` and launches
   `${API_BASE}/auth/login?redirect_uri=<loopback>&state=<client csrf>`.
   `redirect_uri` is rejected unless it is a loopback `http:` address.
2. The Worker serves a "Continue with GitHub" page. GitHub's `state` carries the
   pending login (`{redirectUri, csrf}`, base64) so the Worker stays stateless
   between the two hops — no KV write for a flow that may never finish.
3. GitHub redirects to the Worker's own fixed `/auth/github/callback`. The
   Worker exchanges the code, reads `/user`, and applies the **60-day account-age
   gate** (`isAccountOldEnough`) — brand-new accounts are rejected as the
   cheapest anti-abuse lever available.
4. The user row is upserted in D1, a random 32-byte session token is written to
   KV with a 30-day TTL, and the Worker 302s back to the loopback with
   `?sessionToken=`.
5. The extension stores it in `SecretStorage` and mirrors it into
   [remoteSessionCache.ts](apps/vscode-extensions/src/services/remote/remoteSessionCache.ts).

**Why the sync cache.** `getLlmSettings` is synchronous and called from
synchronous paths (e.g. `DeploymentMessageHandler.hasLlm()`), but
`SecretStorage` is async-only. The token changes twice per session, so it is
primed once during `activate()` and updated by `RemoteSignInService` — the only
writer. It is a cache of a credential, never an authority on it: a stale value
fails closed with a 401.

---

## 4. Per-request validation

Requirement: *every* inference request proves the caller is signed in and valid.
[chat.ts](apps/workspacegpt-api/src/chat.ts) runs, in order:

| Step | Failure |
|---|---|
| `OPENROUTER_API_KEY` present | `500 server_misconfigured` — before anything is charged |
| KV session for the bearer token | `401 not_signed_in` |
| D1 user row exists and `status = 'active'` | `403 account_inactive` |
| Body is JSON with non-empty `messages` | `400 invalid_request` |
| Weekly quota (increment-then-compare, one statement) | `429 weekly_limit_reached` + `Retry-After` |
| Upstream OpenRouter call | `502 upstream_unreachable` / `502 upstream_auth_failed` |

There is **no client-side grace period**. An expired or revoked session stops
working on its next request. The extension's own pre-send check
([WebviewMessageHandler](apps/vscode-extensions/src/handlers/WebviewMessageHandler.ts))
is a local token-presence test only — a UX shortcut, explicitly not the
security boundary. `Settings → Account` is the one place that round-trips
`/v1/me`, so a server-side revocation shows up there as signed out.

**Never conflate upstream auth with user auth.** An OpenRouter 401/403 means the
*vendor's* key is bad; passing it through would make the client tell the user to
sign in again for a server-side fault. It is remapped to `502
upstream_auth_failed`, and the client's `describeLlmFailure` only rewrites
401/403/429 for `provider === REMOTE_MODEL.PROVIDER`.

---

## 5. Model selection

One managed model for every task. The client sends the symbolic id
`REMOTE_MODEL.ID` (`workspacegpt-default`) and the Worker **overrides it** with
the configured model — so changing models never touches the extension. It does
not even need a deploy; see §7. The former client-side `REMOTE_TASK_MODELS`
(chat/codegen/classification/title → Gemini) is deleted along with the `LlmTask`
type: task-based routing was cost tuning that belongs on the server, and it
required shipping the vendor's model choices — and the user's own Gemini keys —
inside the client. Per-plan or per-task models can come back as extra
`app_config` keys without touching the client at all.

Request fields are forwarded by **allowlist**, not blocklist, so the client
cannot smuggle in OpenRouter routing knobs (`provider`, `models`, `transforms`)
that change who pays or what is logged. `tools` / `tool_choice` are on the list
and matter most: the agent loop is tool-calling, and a proxy that dropped them
would silently reduce remote mode to plain chat.

---

## 6. Usage caps

Every request spends the vendor's single OpenRouter key, so admission control
is not optional. **200 requests per week** is the default.
[usage.ts](apps/workspacegpt-api/src/usage.ts):

- `usage_weekly(user_id, week, requests)` in D1, bucketed by **ISO-8601 week in
  UTC** (`2026-W36`) — weeks start Monday, so the cap resets Monday 00:00 UTC
  for everyone.
- ISO weeks, not "day-of-year / 7": the boundary is always a Monday midnight and
  never drifts per year. The key carries the ISO *week-year*, so late December
  and early January land in the same bucket when they share a week
  (`2025-12-29` → `2026-W01`).
- One `INSERT … ON CONFLICT DO UPDATE … RETURNING` per admitted request, so two
  concurrent calls can't both read the same pre-increment value and slip past
  the cap together.
- Limits resolve per account, highest precedence first: the
  `users.weekly_request_limit` override → the configured plan→limit map → the
  configured fallback for unlisted plans. All three are configurable (§7), so
  raising one customer's ceiling is a one-column `UPDATE` and raising a whole
  plan's is a one-row edit.
- An over-limit request is still counted (it is rejected anyway, and counting it
  stops a hammering client from resetting its own denominator). A malformed
  request is *not* counted — validation runs before the quota is spent.
- `429` carries `Retry-After` (seconds to the next Monday). Note the `openai`
  client ignores `Retry-After` above 60s, so it surfaces the error rather than
  sleeping for days.

`/v1/me` returns `plan`, `requests_used_this_week` and `requests_limit_weekly`
so Settings → Account can show the remaining allowance without a second call.
Successful proxy responses also carry `X-WorkspaceGPT-Requests-Used`,
`-Limit` and `-Period: week`.

**The window itself is fixed at a week**, deliberately not configurable: the
bucket key encodes the period, so flipping it at runtime would leave existing
rows keyed by the old window and make every in-flight count ambiguous. Changing
it is a migration (as `0004_weekly_usage.sql` was), not a config edit.

---

## 7. Configuration

Three knobs matter operationally — **which provider**, **which model**, and
**how many requests per week** — and none should require a deploy to turn, let
alone an extension release. All three resolve through three layers, highest
precedence first:

| Layer | Where | Changes take effect |
|---|---|---|
| 1 | a row in the `app_config` D1 table | **next request** — no deploy |
| 2 | a `var` in `wrangler.jsonc` | next `wrangler deploy` |
| 3 | constants in [config.ts](apps/workspacegpt-api/src/config.ts) | next deploy (last-resort fallback) |

Layer 1 is read on **every** request, batched with the user lookup
(`loadAccount` in [db.ts](apps/workspacegpt-api/src/db.ts)), so configurability
costs no extra round trip and there is no cache to wait out.

### Turning the knobs

Change the provider (`openrouter` or `gmicloud` — see `PROVIDERS` in
[config.ts](apps/workspacegpt-api/src/config.ts)). Switching to a provider
whose key was never set fails closed with `server_misconfigured`, so set the
key first:

```bash
wrangler secret put GMICLOUD_API_KEY
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('inference_provider', 'gmicloud', unixepoch())"
```

Change the model (must support tool calling — the agent loop depends on it;
use whatever id format the currently configured provider expects):

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('openrouter_model', 'anthropic/claude-sonnet-4.5', unixepoch())"
```

Change every plan's weekly cap:

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('plan_weekly_limits', '{\"free\":200,\"pro\":5000}', unixepoch())"
```

Change the weekly cap for plans absent from that map:

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('weekly_request_limit', '500', unixepoch())"
```

Raise (or throttle) one account, without inventing a plan for them:

```bash
wrangler d1 execute workspacegpt-db --remote --command "UPDATE users SET weekly_request_limit = 2000 WHERE login = 'someone'"
```

Revert any override by deleting its row (e.g. `DELETE FROM app_config WHERE
key = 'openrouter_model'` or `key = 'inference_provider'`) or nulling the
column — the layer below takes over.

### Rules the parser follows

- A malformed or non-object `plan_weekly_limits` blob is **ignored with a logged
  error**, and the next layer applies. A typo must never leave requests
  uncapped.
- Individual non-positive-integer entries are dropped, not coerced. `{"free":-5}`
  falls through to the layer below rather than granting -5 or unlimited.
- Blank/whitespace values count as unset.
- `/v1/me` resolves the limit through the exact same path the proxy enforces, so
  the number shown in Settings → Account is always the number in force.

There is deliberately **no admin HTTP endpoint**. It would need its own
credential and would be attack surface on the one Worker that holds the
OpenRouter key; the `wrangler` CLI already authenticates as the account owner.

---

## 8. Privacy posture

- **At rest, vendor side:** nothing but account rows (`users`), counters
  (`usage_weekly`), and operator settings (`app_config`). No prompts, no
  answers, no documents, no vectors — the index never leaves the user's machine.
- **In flight:** the question and the retrieved snippets pass through Worker
  memory on the way to OpenRouter. Disclosed, never logged: the only
  `console.error` calls in the data plane log a status code and an error
  message shape, never a body.
- **Upstream:** OpenRouter and the model it routes to have their own retention
  policies. The honest claim is scoped: *"WorkspaceGPT stores none of your
  content; inference is performed by OpenRouter."*
- Local mode remains account-free, telemetry-free, and fully offline.

---

## 9. Deploy checklist

1. `wrangler secret put GITHUB_CLIENT_SECRET`
2. `wrangler secret put OPENROUTER_API_KEY` (and `wrangler secret put GMICLOUD_API_KEY` if `inference_provider`/`INFERENCE_PROVIDER` will ever be set to `gmicloud`)
3. `wrangler d1 migrations apply workspacegpt-db --remote` (0001–0004)
4. KV `SESSIONS` and D1 `workspacegpt-db` ids in `wrangler.jsonc` must exist.
5. GitHub OAuth App: add the deployed callback
   `https://<worker>/auth/github/callback`.
6. **Set `REMOTE_AUTH.API_BASE`** in
   [constants.ts](apps/vscode-extensions/constants.ts) to the deployed
   `*.workers.dev` URL. It still points at `http://127.0.0.1:8787` — remote mode
   cannot work for any real user until this changes, since their machine has no
   Worker on localhost. This is the single remaining blocker.
7. Pick the production model and weekly caps — the committed defaults are
   `google/gemini-2.5-flash` and free 200 / pro 5000 per week. Both are
   adjustable afterwards without a deploy (§7), so this is a starting point,
   not a commitment. Confirm the model supports tool calling.

Pushes to `main` touching `apps/workspacegpt-api/**` deploy automatically via
[deploy-workspacegpt-api.yml](.github/workflows/deploy-workspacegpt-api.yml).

---

## 10. Verified / not verified

Smoke-tested against local `wrangler dev` with seeded KV + D1 state
(2026-08-31).

**Auth + proxy:** unauthenticated and bogus-token chat → 401; valid session →
account + quota checks pass and the request reaches OpenRouter (rejected on a
deliberately fake vendor key → correctly remapped to 502, *not* 401); empty
`messages` → 400 without spending quota; `/v1/me` returns plan + usage;
`redirect_uri=https://evil.com/cb` → 400.

**Configuration, all six precedence cases** (re-run after the move to weekly):
wrangler var applies with no config rows (200/week) → an `app_config` row
overrides it with no redeploy (25) → the per-user column beats both (4) →
clearing the column falls back to the row (25) → an unlisted plan falls through
to the fallback key (60) → malformed JSON (`{nope`) and a negative limit
(`{"free":-5}`) are both ignored in favour of the layer below (200), not
honoured. A config-set cap of 2 was confirmed *enforced*, not merely reported:
third request → `429 weekly_limit_reached` with `Retry-After`, and the D1 row
bucketed under `2026-W36`. Model precedence (row → var → hardcoded, blanks
ignored) checked directly against `resolveConfig`.

**Week math** checked directly against `utcWeek`/`secondsUntilReset`: Sunday and
the following Monday land in different buckets, a full Mon–Sun run shares one
bucket, `2025-12-29` → `2026-W01` (ISO week-year rollover), and the reset
countdown lands exactly on the next Monday 00:00 UTC from Mon, Thu and Sun
starting points.

**Not verified:** a real GitHub OAuth round-trip against the deployed Worker,
and a real streaming completion with tool calls through a live
`OPENROUTER_API_KEY` — which is also the only thing that would prove the
resolved model id reaches OpenRouter end to end (it is one assignment,
`upstreamBody.model = config.model`).

---

## 11. Deferred

| # | Item | Blocked on |
|---|---|---|
| 1 | Share-to-Chrome | a hosted index (see §1) |
| 2 | Stripe checkout/portal → `plan` column | pricing decision |
| 3 | Token-based (not request-based) metering | evidence that request counts misprice usage |
| 4 | Per-minute rate limit on top of the weekly cap | observed burst abuse |
| 5 | Prompt-cache headers | agent dogfooding data |
| 6 | Per-plan / per-task model tiers | just extra `app_config` keys — see §5, §7 |
