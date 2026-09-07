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
| Weekly credit allowance (compare against usage already recorded) | `429 weekly_limit_reached` + `Retry-After` |
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

Every request spends the vendor's single key, so admission control is not
optional. Usage is **metered in tokens and presented as credits** — one credit
is `tokens_per_credit` model tokens (default 1,000) — with one allowance per
account: an **ISO week**. Defaults are placeholders pending a pricing decision:
free 2,000 credits/week, pro 50,000/week. Sized from the eval harness
(2026-09-05): a documentation answer is ~7 credits, an agent run that edits
code ~50.

A second, rolling five-hour allowance shipped alongside credits and was removed
the next day (`0007_drop_rolling_window.sql`). It fired on ordinary use: an
afternoon of agent runs spent a fifth of the week inside the window and locked
the account out for hours while ~78% of its weekly credits sat unspent, and the
UI had to shout about a wall that was not the one approaching. Two clocks also
meant two explanations for one refusal. The weekly cap alone still bounds what
an account can cost, which is the only thing the limit is there to do; a burst
simply spends the week sooner.

Why not count requests: one user message is one HTTP call for a chat answer and
20–40 for an agent turn, so "200 requests/week" bought about five bug fixes and
the number meant nothing a person could plan around. Cursor, Codex and Claude
Code each launched on call/message counting and each moved to token metering
with an abstract unit on top; this follows them rather than repeating the
migration later.

[metering.ts](apps/workspacegpt-api/src/metering.ts) (pure) and
[usage.ts](apps/workspacegpt-api/src/usage.ts) (D1). `pnpm test` in
`apps/workspacegpt-api` runs two files with no Cloudflare runtime:
[test/run.mjs](apps/workspacegpt-api/test/run.mjs) drives the arithmetic
directly, and [test/proxy.mjs](apps/workspacegpt-api/test/proxy.mjs) drives the
Worker's real `fetch` export end to end — the migrations applied to an
in-memory `node:sqlite` standing in for D1, a Map for KV, a scripted upstream —
and checks the tee'd stream reaches the client byte-identical, the
`waitUntil` charge lands, the next request's admission sees it, and refusals
and vendor failures are not charged.

- **Admit → proxy → meter.** Admission compares usage *already recorded*
  against the weekly limit before anything is forwarded; refusal is a `429
  weekly_limit_reached` with `Retry-After` and a sentence naming the reset. The
  request that crosses the limit is always served (an answer cannot be
  un-streamed); the next one is refused.
- **Streamed responses are forced to report usage** (`stream_options.include_usage`
  is set server-side). The upstream body is `tee()`d: one branch goes to the
  client untouched, the other is read to completion in `ctx.waitUntil` to find
  the final `usage` chunk, convert to credits and charge — off the latency
  path, and the body is never logged or stored.
- If the vendor returns no `usage` at all, the charge is estimated from the
  request size (~4 chars/token, prompt only) and a warning is logged. Failed
  upstream calls (vendor 429/5xx) are not charged.
- `usage_weekly(user_id, week, requests, credits, tokens)` keeps the weekly
  aggregate, bucketed by ISO week in UTC (`2026-W36`; Monday reset; the key
  carries the ISO week-year so late December and early January share a bucket
  when they share a week). `requests` is now a statistic, not a limit.
- The limit resolves per account, highest precedence first: the
  `users.weekly_credit_limit` override → the plan map → the fallback. A limit
  of zero or less means uncapped. (`users.weekly_request_limit` is left in the
  schema, unread — its values were call counts.)
- `Retry-After` above 60s is ignored by the `openai` client, so it surfaces the
  error rather than sleeping.

`/v1/me` returns `credits_used_this_week`, `credits_limit_weekly` and
`tokens_per_credit` (plus the request-era names, carrying the same credit
numbers, for one release). Proxy responses carry `X-WorkspaceGPT-Credits-Used`,
`-Credits-Limit` and `-Credits-Period: week` — reflecting usage *before* that
request, since its own cost is only known once it has streamed.

Existing `requests` values were **not** reinterpreted as credits
(`0006_credits.sql`): a call is not a credit, and everyone's credit counters
start at zero — strictly more generous than any conversion for anyone mid-week.

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

Change the provider — `openrouter` (hardcoded URL) or `custom` (any
OpenAI-compatible endpoint, e.g. TokenRouter; see `config.ts`). Each provider
keeps its own key and model; `custom` additionally needs a base URL. Switching
to a provider whose key (and, for `custom`, base URL/model) was never set
fails closed with `server_misconfigured`, so set those first:

```bash
wrangler secret put CUSTOM_API_KEY
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('custom_api_base_url', 'https://api.tokenrouter.com/v1/chat/completions', unixepoch())"
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('custom_model', 'z-ai/glm-5.3-free', unixepoch())"
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('inference_provider', 'custom', unixepoch())"
```

Change the model for whichever provider is active (must support tool calling —
the agent loop depends on it; use the id format that provider expects). Key is
`openrouter_model` for `openrouter`, `custom_model` for `custom`:

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('openrouter_model', 'anthropic/claude-sonnet-4.5', unixepoch())"
```

Change every plan's weekly credit cap:

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('plan_weekly_credits', '{\"free\":2000,\"pro\":50000}', unixepoch())"
```

Change the weekly cap for plans absent from that map:

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('weekly_credit_limit', '2000', unixepoch())"
```

Change what a credit is worth (tokens per credit):

```bash
wrangler d1 execute workspacegpt-db --remote --command "INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES ('tokens_per_credit', '1000', unixepoch())"
```

Raise (or throttle) one account, without inventing a plan for them:

```bash
wrangler d1 execute workspacegpt-db --remote --command "UPDATE users SET weekly_credit_limit = 9000 WHERE login = 'someone'"
```

Revert any override by deleting its row (e.g. `DELETE FROM app_config WHERE
key = 'openrouter_model'` or `key = 'inference_provider'`) or nulling the
column — the layer below takes over.

### Rules the parser follows

- A malformed or non-object `plan_weekly_credits` blob is **ignored with a
  logged error**, and the next layer applies. A typo must never leave usage
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
2. `wrangler secret put OPENROUTER_API_KEY` (and `wrangler secret put CUSTOM_API_KEY` + a `custom_api_base_url` row/`CUSTOM_API_BASE_URL` var if `inference_provider`/`INFERENCE_PROVIDER` will ever be set to `custom`)
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
