# WorkspaceGPT — Architecture

WorkspaceGPT lets you ask questions over your Confluence & Azure DevOps
knowledge base. It ships as two clients backed by a thin proxy:

- **VS Code extension** (`apps/vscode-extensions`) — the **master**. Syncs and
  indexes sources, holds all credentials, and is where everything is configured.
- **Chrome extension** (`apps/chrome-extension`) — a **read-only consumer**. It
  holds no credentials; it exists only after you "Share" from VS Code.
- **Cloudflare Worker** (`apps/workspacegpt-worker`) — a credential-holding
  **share proxy** so the Chrome extension never sees real API keys.
- **Vercel function** (`apps/confluence-auth-proxy`) — Confluence OAuth token
  exchange only (genuinely needs a server-side `client_secret`).

---

## 1. Roles

### VS Code = master / indexer (full control)
- Configurable: AI provider + model + key; embeddings (**local ONNX** or
  **Gemini**); vector store (**local file** or **Qdrant cloud**).
- Syncs Confluence/ADO, embeds the corpus, and — in cloud mode — populates
  Qdrant. Can run **fully local** for personal use.

### Chrome = read-only consumer (born from "Share")
- No settings beyond a single **share code** (token). No API keys, no model
  names, no Qdrant URL.
- Sends questions to the Worker; renders the streamed answer.

### "Gemini everywhere" invariant
Corpus and query **must** share one embedding model/vector space. ONNX (384-dim)
and Gemini (768-dim, MRL-truncated) are incompatible — cross-querying returns
garbage. Therefore **sharing requires Gemini embeddings + Qdrant cloud**; local
ONNX (Chrome can't run it) and local file store (Chrome can't reach it) are not
shareable. Every index carries an `embedding:{provider,model,dimensions,
normalized}` manifest; `checkEmbeddingCompat` fails search loud on mismatch.

---

## 2. The sharing model

The Chrome extension must call Gemini (embed query), Qdrant (search), and the
LLM (chat). If it held those keys directly, anyone with the packaged extension
could extract them. Instead, **keys live server-side in the Worker's KV**, keyed
by a random share token. Chrome holds only the token.

```
VS Code (master, holds all keys)
   │  "Share to Chrome Extension"
   │  gate: Gemini embed + Qdrant cloud + chat key
   └── POST /share {qdrant, gemini, llm}            ┌─────────────┐
       Authorization: Bearer ADMIN_SECRET  ───────► │  Worker     │──► KV: token → {creds}
                                                     │ (Cloudflare)│
       ◄─── { token }  (copy → paste into Chrome) ── └─────────────┘

Chrome (holds only the token)
   ├── POST /search {query, sources}                 Worker looks up creds, then:
   │   Authorization: Bearer <token>   ───────────►  Gemini embed query → Qdrant search → { hits }
   │
   └── POST /chat {messages}                         Worker looks up creds, then:
       Authorization: Bearer <token>   ───────────►  LLM /chat/completions (SSE) ──► streamed back
```

**Embeddings are never transferred.** They already live in Qdrant cloud (VS Code
pushed them during sync). The share bundle is **credentials only** — a few
hundred bytes.

### Share bundle (stored in KV under the token)
```jsonc
{
  "qdrant": { "url": "...", "apiKey": "...", "collectionPrefix": "" },
  "gemini": { "apiKey": "...", "model": "gemini-embedding-001", "dimensions": 768 },
  "llm":    { "baseUrl": "...", "apiKey": "...", "model": "..." },
  "label":  "optional — shown in Manage Shares",
  "createdAt": "ISO-8601"
}
```

---

## 3. Worker API (`apps/workspacegpt-worker`)

Single Worker, path-routed. KV namespace binding `SHARES`. Auth is always
`Authorization: Bearer <secret-or-token>`.

| Method | Path            | Auth           | Purpose |
|--------|-----------------|----------------|---------|
| POST   | `/share`        | `ADMIN_SECRET` | Create a share → `{token}` |
| GET    | `/shares`       | `ADMIN_SECRET` | List `{token,label,createdAt}` |
| DELETE | `/share/:token` | `ADMIN_SECRET` | Revoke a share |
| POST   | `/search`       | share token    | Gemini-embed query + Qdrant search → `{hits}` |
| POST   | `/chat`         | share token    | Stream chat completion (SSE passthrough) |

- `/search` embeds server-side and over-fetches across the requested sources,
  filtering the reserved manifest point (id `0`).
- `/chat` pipes the upstream OpenAI-compatible SSE stream straight through —
  negligible CPU, no buffering.

### Security properties
- **Keys never reach Chrome** — only a revocable token.
- **Revocation is instant** — `DELETE /share/:token` removes the KV entry; the
  connected extension stops working immediately, underlying keys untouched.
- `preview_urls = false` — exactly one public endpoint for a credential proxy.

---

## 4. Why Cloudflare (not Vercel)

The Vercel account is near its **Fluid Active CPU** cap, and a streaming LLM
proxy is CPU-billed there. Cloudflare Workers bill streaming as ~0 CPU (it's
I/O), the free tier is generous (100K req/day), and **KV replaces MongoDB**
(token→config is read-heavy, write-rare). Vercel is kept **only** for the
Confluence OAuth token exchange, which truly needs a server-side secret.

---

## 5. Deployment & operations

### One-time Worker setup
```bash
cd apps/workspacegpt-worker
pnpm install
npx wrangler login
npx wrangler kv namespace create SHARES   # paste id into wrangler.toml
npx wrangler secret put ADMIN_SECRET       # generate a strong random value
npx wrangler deploy
```

### CI (auto-deploy on push to main)
`.github/workflows/deploy-worker.yml` runs `wrangler deploy` when
`apps/workspacegpt-worker/**` changes. Requires repo secrets:
- `CLOUDFLARE_API_TOKEN` — "Edit Cloudflare Workers" token
- `CLOUDFLARE_ACCOUNT_ID`

KV and `ADMIN_SECRET` are one-time and persist across deploys; CI never sees them.

### Connecting the clients
- **VS Code**: set `workspacegpt.shareWorkerUrl` to the deployed Worker URL, then
  run **WorkspaceGPT: Share to Chrome Extension** (enter `ADMIN_SECRET` once;
  stored in SecretStorage). **Manage Shares** lists/revokes tokens.
- **Chrome**: built with `VITE_WORKER_URL=<worker-url>` (default in
  `src/lib/config.ts`); user pastes the share code in Settings.

### Current deployment
- URL: `https://workspacegpt-worker.ritesh-kant47.workers.dev`
- `ADMIN_SECRET` is set on the Worker (held by the admin, not in the repo).

---

## 6. Shared code

`packages/embedding-core` (`@workspace-gpt/embedding-core`) is the single source
of truth for embedding identity/profiles, the Gemini provider, the Qdrant store,
and the compat check — consumed by the VS Code extension. The Worker inlines the
small query-embed call to keep its deploy dependency-free; the Chrome extension
no longer embeds or searches (the Worker does), so it depends on neither.

---

## 7. Known limitations / deferred

- Cloud sync re-upserts the full index each run (no incremental tracking).
- Deletions don't propagate to Qdrant.
- Chrome has no chat-history persistence.
- Chunking deferred — long docs are truncated, not split.
- `collectionPrefix` is plumbed through the Worker but VS Code always sends `""`.
