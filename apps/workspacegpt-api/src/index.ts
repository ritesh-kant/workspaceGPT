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
import { weeklyCreditLimitFor } from './metering';
import { readUsageSnapshot } from './usage';

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

/**
 * Only ever 302 the session token back to the extension's fixed loopback
 * callback (see REMOTE_AUTH in apps/vscode-extensions/constants.ts). An
 * arbitrary `localhost` port would let a same-machine phishing page steal
 * the token after GitHub consent.
 */
const CLIENT_CALLBACK_PORT = '32329';
const CLIENT_CALLBACK_PATH = '/callback';

function isAllowedClientRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'http:' &&
      u.hostname === '127.0.0.1' &&
      !u.username &&
      !u.password &&
      u.port === CLIENT_CALLBACK_PORT &&
      u.pathname === CLIENT_CALLBACK_PATH &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

/** Stable codes only — never put Error.message in the loopback query string. */
function oauthErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('account_too_new')) return 'account_too_new';
  return 'oauth_failed';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    // GET /auth/login?redirect_uri=<client loopback>&state=<client csrf>
    if (url.pathname === '/auth/login' && request.method === 'GET') {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return html(renderErrorPage('Sign-in is not configured on the server.'), { status: 503 });
      }
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const csrf = url.searchParams.get('state') ?? '';
      if (!redirectUri || !csrf || csrf.length < 16 || csrf.length > 128) {
        return html(renderErrorPage('Missing redirect_uri or state.'), { status: 400 });
      }
      if (!isAllowedClientRedirect(redirectUri)) {
        return html(
          renderErrorPage('redirect_uri must be the WorkspaceGPT extension callback (http://127.0.0.1:32329/callback).'),
          { status: 400 }
        );
      }

      const callbackUrl = `${url.origin}/auth/github/callback`;
      const pendingState = await encodePendingLogin({ redirectUri, csrf }, env.GITHUB_CLIENT_SECRET);
      const githubAuthorizeUrl = buildGithubAuthorizeUrl(env, callbackUrl, pendingState);
      return html(renderLoginPage(githubAuthorizeUrl));
    }

    // GET /auth/github/callback?code=...&state=<encoded pending>
    if (url.pathname === '/auth/github/callback' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';
      const githubError = url.searchParams.get('error');
      const pending = await decodePendingLogin(state, env.GITHUB_CLIENT_SECRET);

      if (!pending || !isAllowedClientRedirect(pending.redirectUri)) {
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
        await upsertUser(env, ghUser.id, ghUser.login, ghUser.created_at, ghUser.email);
        const sessionToken = await createSession(env, String(ghUser.id), ghUser.login, ghUser.email);
        return backToClient({ sessionToken });
      } catch (error) {
        return backToClient({ error: oauthErrorCode(error) });
      }
    }

    // POST /v1/chat/completions — the remote-mode data plane (OpenAI-compatible
    // proxy to OpenRouter). Validates the session on every request; see chat.ts.
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env, ctx);
    }

    // GET /v1/me — Authorization: Bearer <sessionToken>
    if (url.pathname === '/v1/me' && request.method === 'GET') {
      const token = bearerToken(request);
      const session = token ? await getSession(env, token) : null;
      if (!session) return json({ error: 'not_signed_in' }, { status: 401 });
      // Plan + usage ride along so Settings → Account can show the remaining
      // allowance without a second round trip. Limits are resolved exactly as
      // the chat proxy resolves them, so the numbers shown are the numbers
      // actually enforced.
      const { user, config } = await loadAccount(env, session.userId);
      const limitUser = { plan: user?.plan ?? 'free', weekly_credit_limit: user?.weekly_credit_limit ?? null };
      const snapshot = await readUsageSnapshot(env, session.userId);
      const creditsLimitWeekly = weeklyCreditLimitFor(limitUser, config);
      return json({
        github_login: session.login,
        email: session.email ?? null,
        plan: user?.plan ?? 'free',
        status: user?.status ?? 'active',
        credits_used_this_week: snapshot.weeklyCredits,
        credits_limit_weekly: creditsLimitWeekly,
        tokens_per_credit: config.tokensPerCredit,
        // Request-era field names, kept one release so an extension that
        // predates credits still draws a sensible bar. Same numbers.
        requests_used_this_week: snapshot.weeklyCredits,
        requests_limit_weekly: creditsLimitWeekly,
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
