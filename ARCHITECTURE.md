# WorkspaceGPT — Architecture

WorkspaceGPT lets you ask questions over your Confluence & Azure DevOps
knowledge base. It ships as two clients with **no backend of its own**:

- **VS Code extension** (`apps/vscode-extensions`) — the **master**. Syncs and
  indexes sources, holds all credentials, and is where everything is configured.
- **Chrome extension** (`apps/chrome-extension`) — a **read-only consumer**. It
  is configured entirely from a "share code" produced by VS Code, then talks
  directly to Gemini / Qdrant / the LLM.
- **Vercel function** (`apps/confluence-auth-proxy`) — Confluence OAuth token
  exchange only (the one thing that genuinely needs a server-side `client_secret`).

There is **no proxy/worker** in the data path. Sharing is done by copying an
encoded bundle of credentials from VS Code into Chrome.

---

## 1. Roles

### VS Code = master / indexer (full control)
- Configurable: AI provider + model + key; embeddings (**local ONNX** or
  **Gemini**); vector store (**local file** or **Qdrant cloud**).
- Syncs Confluence/ADO, embeds the corpus, and — in cloud mode — populates
  Qdrant. Can run **fully local** for personal use.

### Chrome = read-only consumer (born from "Share")
- No manual configuration. You paste a single **share code** into Settings; that
  code carries the credentials it needs.
- Embeds the query with Gemini, searches Qdrant, and streams the answer from the
  LLM — all directly, client-side.

### "Gemini everywhere" invariant
Corpus and query **must** share one embedding model/vector space. ONNX (384-dim)
and Gemini (768-dim, MRL-truncated) are incompatible — cross-querying returns
garbage. Therefore **sharing requires Gemini embeddings + Qdrant cloud**; local
ONNX (Chrome can't run it) and local file store (Chrome can't reach it) are not
shareable. Every index carries an `embedding:{provider,model,dimensions,
normalized}` manifest; `checkEmbeddingCompat` fails search loud on mismatch.

---

## 2. The sharing model: keys-in-bundle

The Chrome extension needs to call Gemini (embed query), Qdrant (search), and the
LLM (chat). Rather than route those through a server, **the share code *is* the
credentials**: VS Code packages its own keys into a small bundle, base64-encodes
it, and copies it to the clipboard. The user pastes it into Chrome, which stores
it locally and uses it directly.

```
VS Code (master, holds all keys)
   │  "Share to Chrome Extension"
   │  gate: Gemini embed + Qdrant cloud + chat key
   └── base64( {qdrant, gemini, llm} )  ──►  clipboard
                                              │
                                   (user pastes the code)
                                              ▼
Chrome (stores the decoded creds in chrome.storage.local)
   ├── Gemini  embedContent(query)            → query vector
   ├── Qdrant  /points/search (per source)    → hits
   └── LLM     /chat/completions (SSE)         → streamed answer
```

**Embeddings are never transferred.** They already live in Qdrant cloud (VS Code
pushed them during sync). The share bundle is **credentials only** — a few
hundred bytes.

### Share bundle (the decoded share code)
```jsonc
{
  "v": 2,
  "qdrant": { "url": "...", "apiKey": "...", "collectionPrefix": "" },
  "gemini": { "apiKeys": ["..."] },          // model/dims are pinned (gemini-embedding-001, 768)
  "llm":    { "baseUrl": "...", "apiKeys": ["..."], "model": "..." }
}
```

`gemini.apiKeys` / `llm.apiKeys` carry every key configured for 429 failover in
VS Code (not just the first) — Chrome retries with the next key on a rate limit,
same as the VS Code extension. `v: 1` bundles (single `apiKey` string) still
decode; `decodeShareCode` normalizes either shape into an `apiKeys[]` list.

Producer: `apps/vscode-extensions/src/utils/shareToChrome.ts`.
Consumer: `apps/chrome-extension/src/lib/storage.ts` (`ShareBundle`, `decodeShareCode`).
Chrome-side failover: `apps/chrome-extension/src/lib/keyFailover.ts` (`withKeyFailover`,
mirrors `apps/vscode-extensions/src/utils/apiKeyFailover.ts`), used in
`apps/chrome-extension/src/lib/ragService.ts` for the LLM call; Gemini embedding
rotation is built into `GeminiEmbeddingProvider` in `packages/embedding-core`.

### Security model & tradeoff
- The share code contains **real API keys in plain form** (base64 is encoding,
  not encryption). Anyone with the code — or access to the browser's storage —
  has those keys. The UI says so.
- It is meant for sharing to **your own browser or people you trust**, not for
  public posting.
- **Revocation = rotate your keys.** There is no central registry to revoke; an
  old code stops working once you rotate the Qdrant / Gemini / LLM keys it carries.

---

## 3. Why no server

This extension is **public** — anyone can install it and share to their own
browser. A central credential-holding service (we prototyped a Cloudflare Worker
+ KV, and considered a Vercel proxy and GitHub/Google login) was rejected because
for a public tool it would make the maintainer:

1. **A custodian of every user's API keys** — thousands of strangers' Gemini /
   Qdrant / LLM secrets sitting in one account's storage, and liable for them.
2. **A cost/abuse center** — all users' search + chat traffic funneled through
   one free-tier account.

Keys-in-bundle removes both: each user owns their own keys and their own risk,
nothing is hosted, nothing is paid for, and there is no login or admin secret to
manage. The only retained server is the Confluence OAuth token exchange
(`apps/confluence-auth-proxy`, on Vercel), which can't run client-side because it
needs a confidential `client_secret`.

---

## 4. Client flows

### VS Code — creating a share
`workspacegpt.shareToChrome` (reachable from the sidebar `⋯` menu **and** the ⚙
Settings panel → "Share to Chrome" → **Create share code**):
1. Reads current settings via `getEmbeddingSettings` / `getVectorStoreSettings` /
   `getLlmSettings`.
2. Gates on Gemini embeddings + Qdrant cloud + a chat model with a key.
3. Builds the bundle, base64-encodes it, copies it to the clipboard, and shows a
   warning that it contains plain keys.

The ⚙-panel button posts a `SHARE_TO_CHROME` message that `SystemMessageHandler`
turns into the command — no admin secret, no Worker URL, no login.

### Chrome — using a share
`src/sidepanel/Settings.tsx` provides a paste-the-share-code box; `decodeShareCode`
validates and stores it. `src/lib/ragService.ts` then, per question:
1. `GeminiEmbeddingProvider.embedOne(query, 'query')` → query vector.
2. `QdrantVectorStore.search(vector, topK, source)` across the selected sources,
   merged + sorted.
3. `POST {llm.baseUrl}/chat/completions` (stream) → SSE deltas rendered live.

---

## 5. Shared code

`packages/embedding-core` (`@workspace-gpt/embedding-core`) is the single source
of truth for embedding identity/profiles, the Gemini provider, the Qdrant store,
the compat check, and `makeVectorStore`. It is consumed by **both** the VS Code
extension and the Chrome extension, so the two can't drift on embedding shape or
vector-store behavior.

---

## 6. Deployment & operations

- **Sharing requires no deployment.** Build and install the two extensions; the
  share code is generated and consumed entirely on the users' machines.
  - VS Code: `cd apps/vscode-extensions && pnpm build` (webview is built first via
    `tsc && vite build`, then the host via esbuild).
  - Chrome: `cd apps/chrome-extension && pnpm build` → load `dist/` unpacked.
- **Confluence OAuth (Vercel):** `apps/confluence-auth-proxy` exposes `api/token.ts`.
  Set `ATLASSIAN_CLIENT_ID` + `ATLASSIAN_CLIENT_SECRET` in the Vercel project.

---

## 7. Known limitations / deferred

- Cloud sync re-upserts the full index each run (no incremental tracking).
- Deletions don't propagate to Qdrant.
- Chrome has no chat-history persistence.
- Chunking deferred — long docs are truncated, not split.
- `collectionPrefix` is carried in the bundle but VS Code always sends `""`.
- The share code is plain (base64) — there is no encryption or central revocation
  by design; rotate keys to invalidate old codes.
