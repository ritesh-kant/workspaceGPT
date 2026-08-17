# WorkspaceGPT — Remote Mode as a Managed Service (Design)

> Status: **Draft for review** · Owner: Ritesh · Last updated: 2026-08-15
>
> Re-architects **remote mode** from "bring your own Gemini + Qdrant keys" into
> a commercial, subscription-backed managed engine — while keeping a hard
> guarantee: **WorkspaceGPT's servers never store readable customer content**
> (no code, no Confluence/ADO text). Local mode is untouched.

---

## 1. The two modes (product definition)

| | **Local** (free) | **Remote** (paid, managed) |
|---|---|---|
| Chat model | Bring-your-own (Ollama, OpenAI, Gemini…) | Managed — vendor picks/routes models server-side |
| Embeddings | Bundled local ONNX | Managed (vendor's embedding provider + keys) |
| Vector index | Local file store | Vendor-hosted, per-tenant, **encrypted payloads** |
| Keys the user handles | Their own model keys | **One WorkspaceGPT subscription key** |
| Share-to-Chrome | Hidden | Enabled (bundle = subscription key + tenant + decryption key) |
| Data leaves machine | Never | Only in-flight through vendor proxy; never stored readable |

Today's remote mode already hides the model picker and routes tasks via
`REMOTE_TASK_MODELS` ([constants.ts](apps/vscode-extensions/constants.ts)) — but
the routing table, the Gemini keys, and the Qdrant credentials all live on the
client. This design moves **routing + provider keys + vector storage** behind a
vendor API and replaces the per-provider key UI with a single subscription key.

---

## 2. Design principles

1. **Zero readable content at rest on the vendor side.** Chunk text is
   encrypted client-side before upload; the vendor stores vectors + ciphertext
   and cannot decrypt. The privacy claim is *"we physically can't read your
   documents"*, not *"we promise not to."*
2. **Stateless compute, metered usage.** The backend is a proxy + meter. No
   databases of content, no session state. The only durable vendor data:
   tenant/entitlement/usage rows and the (encrypted) vector index.
3. **Model selection is a server-side concern.** `REMOTE_TASK_MODELS` moves to
   the backend as per-plan config. Model upgrades/downgrades need no extension
   release.
4. **Local mode is sacred.** Nothing in this design adds a network dependency,
   account, or telemetry to local mode. The mode switch stays the single seam.
5. **Cost floor near zero.** Every vendor component is pay-per-request or
   free-tier; the marginal cost of a tenant is almost purely upstream
   LLM/embedding tokens — which is what the subscription prices.

---

## 3. Architecture

```
 CLIENTS (customer machines)                     VENDOR (AWS)                      UPSTREAM
┌──────────────────────────────┐      ┌──────────────────────────────────┐   ┌──────────────┐
│ VS Code (master)             │      │  API GW (HTTP) + Lambda           │   │ Gemini /     │
│  · Confluence/ADO OAuth+sync │      │   POST /v1/upsert                 │──▶│ embedding    │
│  · chunking                  │─────▶│   POST /v1/search                 │   │ provider     │
│  · AES-256-GCM encrypt chunk │      │   POST /v1/collections/... admin  │   └──────────────┘
│  · holds tenant content key  │      │  Lambda Function URL (streaming)  │   ┌──────────────┐
│                              │─────▶│   POST /v1/chat  (SSE)            │──▶│ chat models  │
│ Chrome (consumer)            │      │                                   │   │ (per-plan    │
│  · share bundle: sub key +   │      │  DynamoDB: tenants/usage (no      │   │  routing)    │
│    tenantId + content key    │      │   content) · SSM: vendor keys     │   └──────────────┘
│  · decrypts payloads locally │      │  Vector store: vectors +          │
└──────────────────────────────┘      │   CIPHERTEXT payloads, per tenant │
                                      │  Stripe ⇄ webhook → entitlement   │
                                      └──────────────────────────────────┘
```

### 3.1 What each side does

**Client (VS Code = master, Chrome = read-only consumer)**
- Source auth + sync (Confluence/ADO OAuth) — unchanged, entirely client-side.
- Chunking — unchanged, client-side.
- **Content encryption**: on first remote-mode setup, VS Code generates a
  random AES-256-GCM key (WebCrypto — available in both the extension host and
  Chrome). Every chunk's text + title/url metadata is encrypted before upload.
  The key lives in VS Code `SecretStorage` and reaches Chrome only inside the
  share bundle.
- Query flow: send plaintext question → `/v1/search` returns encrypted hits →
  client decrypts → client builds the RAG prompt → `/v1/chat` streams the
  answer. (The question and prompt transit the vendor in plaintext — that's
  in-flight, not at-rest; see §6.)
- Share bundle v3: `{ v:3, apiKey, tenantId, contentKey }`. No Gemini/Qdrant/
  LLM keys ever again — this also fixes the current design's "real provider
  keys in plain base64" weakness for free.

**Server (vendor, AWS)**
- `/v1/upsert` — validate subscription key → quota check → embed the plaintext
  chunk text (sent alongside its ciphertext) with the vendor embedding key →
  store `{vector, ciphertext, chunkId, contentHash}` in the tenant's index →
  discard plaintext. Nothing readable persisted.
- `/v1/search` — embed the query → vector search in the tenant's index →
  return encrypted payloads + scores.
- `/v1/chat` — per-plan task→model routing (the server-side successor of
  `REMOTE_TASK_MODELS`) → stream from the upstream provider → meter tokens.
- Entitlement: Stripe Checkout → webhook Lambda → DynamoDB row
  `{apiKey, tenantId, plan, status, tokensUsedPeriod, chunkCount}`.

### 3.2 Why the plaintext chunk is sent at all

Embeddings must be computed from plaintext, and client-side embedding would
recreate local mode's constraints (Chrome can't run ONNX; per-client model
drift breaks the shared vector space). So plaintext transits the embed call and
is embedded server-side — but only the ciphertext twin is stored. The invariant
is **at-rest zero-readability**, enforced by code review + the logging rules in
§6, not by never touching bytes.

---

## 4. AWS service choices (lean-first)

| Concern | Service | Why / cost shape |
|---|---|---|
| API (upsert/search/admin) | **API Gateway HTTP API + Lambda** | Pay-per-request, $0 idle. |
| Chat streaming | **Lambda Function URL, response streaming** | API GW buffers + 29s cap breaks SSE; Function URLs stream. |
| Vector store (option A, default) | **S3 Vectors** | Serverless, pay for storage+queries only, zero idle, per-tenant index. Sub-second (not ms) latency — fine for RAG. **Verify GA status** before committing. |
| Vector store (option B, fallback) | **Qdrant on 1× EC2 t4g.small + gp3** | ~$15/mo flat, multi-tenant via per-tenant collections, reachable only from Lambda SG. More ops (backups/upgrades) on us. |
| Entitlement + usage | **DynamoDB on-demand** | Metadata only; free tier covers early stage. |
| Vendor provider keys | **SSM Parameter Store (SecureString)** | Free; Secrets Manager only if rotation is later needed. |
| Billing | **Stripe** (not an AWS service) | Checkout + customer portal + webhook. |
| Abuse control | API GW throttling/usage plans (+ WAF later) | Caps upstream token burn per key. |
| Bill backstop | **AWS Budgets alarm** | Catch runaway spend. |
| Observability | CloudWatch metrics + status-code logs | **No request bodies. Ever.** (§6) |

Explicit non-choices: no S3 for content, no RDS, no Cognito (subscription API
keys, not user login, for v1), no ECS/EC2 for the API tier.

---

## 5. API surface (v1 sketch)

```
POST /v1/upsert       { chunks: [{ id, text, ciphertext, contentHash, source }] }
                      → { upserted, skipped }          // skipped = unchanged contentHash
POST /v1/search       { query, topK, sources? }
                      → { hits: [{ id, score, ciphertext, source }] }
POST /v1/chat         { task, messages }               // task ∈ chat|codegen|classification|title
                      → SSE stream                     // server picks the model per plan+task
DELETE /v1/chunks     { ids?, source? }                // deletion finally propagates (fixes a
                                                       // known limitation of the current design)
GET  /v1/entitlement  → { plan, status, usage, limits }
```

Auth: `Authorization: Bearer <subscription key>` on every call. The
`contentHash` reuses the existing content-hashing from the embedding pipeline
so re-syncs stay cheap (skip unchanged chunks → no re-embed cost).

---

## 6. Privacy & security model

- **At rest (vendor):** vectors + AES-256-GCM ciphertext + opaque ids/hashes.
  Vendor holds no decryption keys. DynamoDB holds billing metadata only.
- **In flight:** chunk text and prompts pass through Lambda memory during
  embed/chat calls — unavoidable, disclosed. TLS everywhere.
- **Upstream:** the model provider (Gemini etc.) has its own transient
  retention window for abuse monitoring. The marketing claim must be scoped:
  *"WorkspaceGPT stores nothing readable; see [provider]'s retention policy
  for inference."* Enterprise tier can later target providers'
  zero-retention offerings.
- **Logging is the enforcement point.** API GW access-log format excludes
  bodies; Lambda handlers never log `event`/payloads; CloudWatch retention
  14 days. A CI grep (`console.log(event`)-style lint) guards regressions.
- **Key loss = index loss** (by design). If the customer loses the content
  key, ciphertext is unrecoverable — the remedy is re-sync from sources,
  which regenerates everything. Document this; it's the price of the
  can't-read-your-data guarantee.
- **Embedding-inversion caveat:** vectors leak *some* semantic information;
  state honestly that embeddings are stored as-is (searchability requires it).

---

## 7. Client refactor map (what actually changes)

| Today | After |
|---|---|
| `RemoteEngineSettings.tsx` — Gemini key list + Qdrant URL/key + test | One **subscription key** field + "Sign in / Manage subscription" (Stripe portal link) + connection test |
| `REMOTE_TASK_MODELS` in [constants.ts](apps/vscode-extensions/constants.ts) | Deleted client-side; server config per plan |
| `getLlmSettings` remote branch → Gemini keys + provider base URL | Returns `{ baseUrl: VENDOR_API, apiKeys: [subscriptionKey] }`; chat calls hit `/v1/chat` |
| `GeminiEmbeddingProvider` used by client in remote mode | Client no longer embeds in remote mode; `/v1/upsert` does |
| `QdrantVectorStore` direct from clients | New `VendorVectorStore` implementing the same `VectorStore` interface from `packages/embedding-core` (the seam already exists via `makeVectorStore`) |
| Share bundle v2 `{qdrant, gemini, llm}` | v3 `{apiKey, tenantId, contentKey}`; `decodeShareCode` keeps v1/v2 for legacy |
| 429 key-failover (`apiKeyFailover.ts`, `keyFailover.ts`) | Client-side failover retires for remote mode (server owns retries); stays for local-mode BYO providers |
| Deletion doesn't propagate to Qdrant (known limitation) | `DELETE /v1/chunks` fixes it |

New package: **`packages/vendor-client`** — typed API client (auth header,
SSE parsing, encrypt/decrypt helpers) shared by VS Code and Chrome, same
pattern as `packages/embedding-core`.

New app: **`apps/workspacegpt-api`** — the Lambda handlers + IaC (SAM or CDK).
(`apps/workspacegpt-worker` was the torn-down Cloudflare prototype; this
replaces that idea on AWS with the encryption model that makes it viable.)

---

## 8. Migration for existing remote users

Existing remote users have their own Gemini+Qdrant with **unencrypted**
payloads in their own Qdrant — that data never touched vendor infra, so there
is nothing to migrate server-side. Path: subscribe → extension detects legacy
remote config → prompts one **re-sync** (sources are the durable truth; the
index is disposable) → legacy key fields hidden. Keep a `legacy-remote`
read-only code path for one release, then remove.

---

## 9. Pricing shape (placeholder, drives quota design)

- **Free/local** — local mode, no account.
- **Pro (per seat/mo)** — N chat tokens + M indexed chunks; flash-tier models.
- **Team** — higher quotas, pro-tier models for codegen, shared tenant.
- Quotas enforced in the entitlement check; usage surfaced via
  `/v1/entitlement` in Settings.

Unit economics guardrail: embedding cost is bounded by `contentHash` skip
logic; chat cost is bounded by per-plan token quotas + API GW throttling.

---

## 10. Build order

> **Superseded by [PHASES.md](PHASES.md)** — steps a–h below map onto backend
> phases B1 (a, h-logging), B2 (b–d), B3 (e–g), and Phase 4 (h-launch-gate).

| Step | Deliverable | Notes |
|---|---|---|
| a | `apps/workspacegpt-api`: entitlement middleware + `/v1/chat` streaming proxy + SSM keys + DynamoDB table + Budgets | Smallest sellable slice: managed chat, BYO index untouched |
| b | Vector decision spike: S3 Vectors GA/latency test vs t4g Qdrant | Gate for c |
| c | `/v1/upsert` `/v1/search` `/v1/chunks` + per-tenant index + contentHash skip | Server side of the index move |
| d | `packages/vendor-client` (API client + AES-GCM helpers) | Shared VS Code/Chrome |
| e | VS Code refactor per §7 + re-sync migration prompt | Remote mode now = subscription key |
| f | Chrome: consume bundle v3, decrypt hits locally | Share flow complete |
| g | Stripe checkout/portal/webhook → entitlement | Commercial switch-on |
| h | Logging lint + load/abuse test + ToS/privacy copy | Launch gate |

---

## 11. Open items

| # | Question | Gates |
|---|---|---|
| 1 | S3 Vectors GA status + real search latency at our topK/filters | b/c |
| 2 | Embedding provider for the managed tier (stay Gemini 768-dim MRL vs alternatives) — must stay consistent per tenant (`checkEmbeddingCompat` manifest still applies) | c |
| 3 | Tenant model for Team plan (shared index, per-seat keys?) | g |
| 4 | Which upstream providers offer contractual zero-retention for a future enterprise tier | post-launch |
| 5 | Anonymous vs account-backed subscription keys (key-only is leaner; account enables recovery/rotation UX) | g |
