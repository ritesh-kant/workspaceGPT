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
import { upsertUser } from './db';
import { renderErrorPage, renderLoginPage } from './loginPage';

/**
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
 * production. See CLOUDFLARE-REMOTE-MODE-DESIGN.md for the fuller design
 * this was extracted from (also lost — not recoverable, would need to be
 * rewritten from scratch if wanted).
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

    // GET /v1/me — Authorization: Bearer <sessionToken>
    if (url.pathname === '/v1/me' && request.method === 'GET') {
      const token = bearerToken(request);
      const session = token ? await getSession(env, token) : null;
      if (!session) return json({ error: 'not_signed_in' }, { status: 401 });
      return json({ github_login: session.login });
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
