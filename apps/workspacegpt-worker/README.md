# workspacegpt-worker

Cloudflare Worker that proxies WorkspaceGPT retrieval + chat so the Chrome
extension never holds real credentials. Keys live in Workers KV, keyed by a
random share token; the Chrome client authenticates with just that token.

## One-time setup

```bash
cd apps/workspacegpt-worker
pnpm install

# 1. Authenticate (opens a browser once)
npx wrangler login

# 2. Create the KV namespace, then paste the returned id into wrangler.toml
npx wrangler kv namespace create SHARES

# 3. Set the admin secret (gates share creation/management)
npx wrangler secret put ADMIN_SECRET

# 4. First deploy
npx wrangler deploy
```

After this, every push to `main` that touches `apps/workspacegpt-worker/**`
redeploys automatically via `.github/workflows/deploy-worker.yml`.

### CI setup (GitHub Actions)

The deploy workflow needs two repo secrets
(**Settings → Secrets and variables → Actions**):

| Secret | Where to get it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → right sidebar (Account ID) |

KV and `ADMIN_SECRET` are set once (steps 2–3 above) and persist across
deploys — CI never needs them.

### Connecting the extensions

- **VS Code**: set `workspacegpt.shareWorkerUrl` to the deployed Worker URL
  (printed by `wrangler deploy`), then run **WorkspaceGPT: Share to Chrome Extension**.
- **Chrome**: build with `VITE_WORKER_URL=<worker-url> pnpm build`, or update the
  default in `apps/chrome-extension/src/lib/config.ts`.

## Routes

| Method | Path            | Auth          | Body / Result |
|--------|-----------------|---------------|---------------|
| POST   | `/share`        | `ADMIN_SECRET`| `{qdrant,gemini,llm,label?}` → `{token}` |
| GET    | `/shares`       | `ADMIN_SECRET`| → `{shares:[{token,label,createdAt}]}` |
| DELETE | `/share/:token` | `ADMIN_SECRET`| → `{ok:true}` |
| POST   | `/search`       | share token   | `{query,sources,topK?}` → `{hits}` |
| POST   | `/chat`         | share token   | `{messages}` → SSE stream |

Auth is always `Authorization: Bearer <secret-or-token>`.

To revoke a team member, `DELETE /share/:token` — their extension stops working
immediately; the underlying Qdrant/Gemini/LLM keys are untouched.
