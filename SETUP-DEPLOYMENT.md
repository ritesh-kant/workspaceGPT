# Deployment Automation — Connection Setup

How to connect the write-scoped providers used by the deployment-automation
feature: **GitHub (OAuth App)** and **Vercel (OAuth integration)**. These
credentials live only in the VS Code master and are never shared to the Chrome
extension. See `DEPLOYMENT-AUTOMATION-DESIGN.md` for the full design.

There are three steps per provider: **register the app**, **put the secret on
the proxy**, **paste the public id into the extension**.

---

## 1. GitHub — OAuth App (active path)

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

## 2. Vercel — OAuth integration

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

## 3. Deploy & test

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

## 4. Optional: GitHub App mode (hardening)

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
