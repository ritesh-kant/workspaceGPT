import type { Env } from './env';
import {
  bearerToken,
  buildGithubAuthorizeUrl,
  createSession,
  decodePendingLogin,
  deleteSession,
  encodePendingLogin,
  exchangeCodeForGithubToken,
  fetchGithubUser,
  getSession,
  isAccountOldEnough,
} from './auth';
import { handleChatCompletions } from './chat';
import { loadAccount, upsertUser } from './db';
import { renderErrorPage, renderLoginPage } from './loginPage';
import { dailyLimitFor, readDailyUsage } from './usage';

/**
 * WorkspaceGPT remote-mode backend. Two planes:
 *   · control  — `GET /auth/login`, `GET /auth/github/callback`, `GET /v1/me`,
 *                `POST /auth/logout`: GitHub sign-in, opaque session tokens in
 *                KV, accounts in D1, 60-day account-age gate.
 *   · data     — `POST /v1/chat/completions`: OpenAI-compatible proxy to
 *                OpenRouter on the vendor's key, session-validated per request
 *                and capped per user per day (chat.ts / usage.ts).
 * See CLOUDFLARE-REMOTE-MODE-DESIGN.md at the repo root.
 *
 * RECONSTRUCTED 2026-08-31 — this entire package was deleted by mistake
 * earlier in the same session, before any of it had been committed to git
 * (confirmed via `git log`/`git fsck` — no object exists for it). Rebuilt
 * from the surviving contract in apps/vscode-extensions/constants.ts
 * (REMOTE_AUTH) and services/remote/remoteSignInService.ts (also
 * reconstructed this session): `GET /auth/login`, `GET
 * /auth/github/callback`, `GET /v1/me`, `POST /auth/logout`. This is a
 * functional rebuild matching that contract, NOT a byte-identical restore of
 * whatever was actually running before — re-verify against real GitHub
 * OAuth App credentials and Cloudflare D1/KV resources before trusting it in
 * production. The design doc it was extracted from was
 * lost too; CLOUDFLARE-REMOTE-MODE-DESIGN.md has since been rewritten from
 * the shipped code.
 *
 * The account-age gate (isAccountOldEnough in auth.ts) was missing from the
 * initial reconstruction — `fetchGithubUser` returned `created_at` but
 * nothing checked it, so a brand-new GitHub account could sign in same as an
 * old one. Added back 2026-08-31; see the callback handler below.
 */

/** Only ever redirect back to a loopback address the extension itself opened a server on — never an arbitrary host. */
function isLoopbackRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.protocol === 'http:';
  } catch {
    return false;
  }
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init?.headers ?? {}) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // GET /auth/login?redirect_uri=<client loopback>&state=<client csrf>
    if (url.pathname === '/auth/login' && request.method === 'GET') {
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const csrf = url.searchParams.get('state') ?? '';
      if (!redirectUri || !csrf) {
        return html(renderErrorPage('Missing redirect_uri or state.'), { status: 400 });
      }
      if (!isLoopbackRedirect(redirectUri)) {
        return html(renderErrorPage('redirect_uri must be a loopback (127.0.0.1/localhost) address.'), {
          status: 400,
        });
      }

      const callbackUrl = `${url.origin}/auth/github/callback`;
      const pendingState = encodePendingLogin({ redirectUri, csrf });
      const githubAuthorizeUrl = buildGithubAuthorizeUrl(env, callbackUrl, pendingState);
      return html(renderLoginPage(githubAuthorizeUrl));
    }

    // GET /auth/github/callback?code=...&state=<encoded pending>
    if (url.pathname === '/auth/github/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';
      const githubError = url.searchParams.get('error');
      const pending = decodePendingLogin(state);

      if (!pending || !isLoopbackRedirect(pending.redirectUri)) {
        return html(renderErrorPage('Invalid or expired sign-in attempt. Please try again from VS Code.'), {
          status: 400,
        });
      }

      const backToClient = (params: Record<string, string>) => {
        const dest = new URL(pending.redirectUri);
        dest.searchParams.set('state', pending.csrf);
        for (const [k, v] of Object.entries(params)) dest.searchParams.set(k, v);
        return Response.redirect(dest.toString(), 302);
      };

      if (githubError) {
        return backToClient({ error: githubError });
      }
      if (!code) {
        return backToClient({ error: 'no_code' });
      }

      try {
        const callbackUrl = `${url.origin}/auth/github/callback`;
        const accessToken = await exchangeCodeForGithubToken(env, code, callbackUrl);
        const ghUser = await fetchGithubUser(accessToken);
        if (!isAccountOldEnough(ghUser.created_at)) {
          return backToClient({ error: 'account_too_new' });
        }
        await upsertUser(env, ghUser.id, ghUser.login, ghUser.created_at);
        const sessionToken = await createSession(env, String(ghUser.id), ghUser.login);
        return backToClient({ sessionToken });
      } catch (error) {
        return backToClient({ error: error instanceof Error ? error.message : 'oauth_failed' });
      }
    }

    // POST /v1/chat/completions — the remote-mode data plane (OpenAI-compatible
    // proxy to OpenRouter). Validates the session on every request; see chat.ts.
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env);
    }

    // GET /v1/me — Authorization: Bearer <sessionToken>
    if (url.pathname === '/v1/me' && request.method === 'GET') {
      const token = bearerToken(request);
      const session = token ? await getSession(env, token) : null;
      if (!session) return json({ error: 'not_signed_in' }, { status: 401 });
      // Plan + today's usage ride along so Settings → Account can show the
      // remaining allowance without a second round trip. The limit is resolved
      // exactly as the chat proxy resolves it, so the number shown here is the
      // number actually enforced.
      const { user, config } = await loadAccount(env, session.userId);
      return json({
        github_login: session.login,
        plan: user?.plan ?? 'free',
        status: user?.status ?? 'active',
        requests_used_today: await readDailyUsage(env, session.userId),
        requests_limit_daily: dailyLimitFor(
          { plan: user?.plan ?? 'free', daily_request_limit: user?.daily_request_limit ?? null },
          config
        ),
      });
    }

    // POST /auth/logout — Authorization: Bearer <sessionToken>
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      const token = bearerToken(request);
      if (token) await deleteSession(env, token);
      return json({ ok: true });
    }

    return json({ error: 'not_found' }, { status: 404 });
  },
};
