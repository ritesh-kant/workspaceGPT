# workspacegpt-worker

Cloudflare Worker that proxies WorkspaceGPT retrieval + chat so the Chrome
extension never holds real credentials. Keys live in Workers KV, keyed by a
random share token; the Chrome client authenticates with just that token.

## One-time setup

```bash
cd apps/workspacegpt-worker
pnpm install

# Create the KV namespace, then paste the returned id into wrangler.toml
wrangler kv namespace create SHARES

# Set the admin secret (gates share creation/management)
wrangler secret put ADMIN_SECRET

wrangler deploy
```

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
