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
│   apiKey: sessionToken })  │      │ data plane                   │
│                           │◀─────│  POST /v1/chat/completions   │
└───────────────────────────┘ SSE  │                              │
                                   │ KV SESSIONS  · D1 users      │
                                   │              · D1 usage_daily│
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
| Daily quota (increment-then-compare, one statement) | `429 daily_limit_reached` + `Retry-After` |
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

One managed model for every task, named by the Worker's `OPENROUTER_MODEL` var.

The client sends the symbolic id `REMOTE_MODEL.ID` (`workspacegpt-default`) and
the Worker **overrides it**. Changing the managed model is a `wrangler deploy`,
never an extension release. The former client-side `REMOTE_TASK_MODELS`
(chat/codegen/classification/title → Gemini) is deleted along with the `LlmTask`
type: task-based routing was cost tuning that belongs on the server, and it
required shipping the vendor's model choices — and the user's own Gemini keys —
inside the client.

Request fields are forwarded by **allowlist**, not blocklist, so the client
cannot smuggle in OpenRouter routing knobs (`provider`, `models`, `transforms`)
that change who pays or what is logged. `tools` / `tool_choice` are on the list
and matter most: the agent loop is tool-calling, and a proxy that dropped them
would silently reduce remote mode to plain chat.

---

## 6. Usage caps

Every request spends the vendor's single OpenRouter key, so admission control
is not optional. [usage.ts](apps/workspacegpt-api/src/usage.ts):

- `usage_daily(user_id, day, requests)` in D1, UTC calendar day.
- One `INSERT … ON CONFLICT DO UPDATE … RETURNING` per admitted request, so two
  concurrent calls can't both read the same pre-increment value and slip past
  the cap together.
- Limits come from the `plan` column that already existed: `free` 200/day,
  `pro` 5000/day, anything else falls back to the `DAILY_REQUEST_LIMIT` var.
  Raising a customer's ceiling is a one-column `UPDATE`.
- An over-limit request is still counted (it is rejected anyway, and counting it
  stops a hammering client from resetting its own denominator). A malformed
  request is *not* counted — validation runs before the quota is spent.

`/v1/me` returns `plan`, `requests_used_today` and `requests_limit_daily` so
`Settings → Account` can show the remaining allowance without a second call.

---

## 7. Privacy posture

- **At rest, vendor side:** nothing but account rows (`users`) and counters
  (`usage_daily`). No prompts, no answers, no documents, no vectors — the index
  never leaves the user's machine.
- **In flight:** the question and the retrieved snippets pass through Worker
  memory on the way to OpenRouter. Disclosed, never logged: the only
  `console.error` calls in the data plane log a status code and an error
  message shape, never a body.
- **Upstream:** OpenRouter and the model it routes to have their own retention
  policies. The honest claim is scoped: *"WorkspaceGPT stores none of your
  content; inference is performed by OpenRouter."*
- Local mode remains account-free, telemetry-free, and fully offline.

---

## 8. Deploy checklist

1. `wrangler secret put GITHUB_CLIENT_SECRET`
2. `wrangler secret put OPENROUTER_API_KEY`
3. `wrangler d1 migrations apply workspacegpt-db --remote` (0001 + 0002)
4. KV `SESSIONS` and D1 `workspacegpt-db` ids in `wrangler.jsonc` must exist.
5. GitHub OAuth App: add the deployed callback
   `https://<worker>/auth/github/callback`.
6. **Set `REMOTE_AUTH.API_BASE`** in
   [constants.ts](apps/vscode-extensions/constants.ts) to the deployed
   `*.workers.dev` URL. It still points at `http://127.0.0.1:8787` — remote mode
   cannot work for any real user until this changes, since their machine has no
   Worker on localhost. This is the single remaining blocker.
7. Pick the production `OPENROUTER_MODEL` (the committed default is
   `google/gemini-2.5-flash`) and confirm it supports tool calling — the agent
   loop depends on it.

Pushes to `main` touching `apps/workspacegpt-api/**` deploy automatically via
[deploy-workspacegpt-api.yml](.github/workflows/deploy-workspacegpt-api.yml).

---

## 9. Verified / not verified

Smoke-tested against local `wrangler dev` with seeded KV + D1 state
(2026-08-31): unauthenticated and bogus-token chat → 401; valid session →
account + quota checks pass and the request reaches OpenRouter (rejected on a
deliberately fake vendor key → remapped 502); empty `messages` → 400 without
spending quota; third request at a limit of 2 → 429 with `Retry-After`;
`/v1/me` returns plan + usage. Loopback-only `redirect_uri` enforcement → 400
for `https://evil.com/cb`.

Not yet verified end to end: a real GitHub OAuth round-trip against the
deployed Worker, and a real streaming completion with tool calls through a live
`OPENROUTER_API_KEY`.

---

## 10. Deferred

| # | Item | Blocked on |
|---|---|---|
| 1 | Share-to-Chrome | a hosted index (see §1) |
| 2 | Stripe checkout/portal → `plan` column | pricing decision |
| 3 | Token-based (not request-based) metering | evidence that request counts misprice usage |
| 4 | Per-minute rate limit on top of the daily cap | observed burst abuse |
| 5 | Prompt-cache headers + per-plan model tiers | agent dogfooding data |
