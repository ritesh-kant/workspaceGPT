import * as vscode from 'vscode';
import { REMOTE_AUTH, STORAGE_KEYS } from '../../../constants';
import { OAuthCallbackServer } from '../deployment/oauthCallbackServer';
import { setCachedRemoteSessionToken } from './remoteSessionCache';

export interface RemoteProfile {
  github_login: string;
  email?: string | null;
  plan?: string;
  status?: string;
  /** Token-metered credits (see apps/workspacegpt-api/src/metering.ts). */
  credits_used_this_week?: number;
  credits_limit_weekly?: number;
  credits_used_window?: number;
  credits_limit_window?: number;
  window_seconds?: number;
  tokens_per_credit?: number;
  /** Request-era fields, still sent by older servers. Same shape, different unit. */
  requests_used_this_week?: number;
  requests_limit_weekly?: number;
}

export type SessionVerifyResult =
  | { state: 'signed_out' }
  | { state: 'signed_in'; profile: RemoteProfile }
  | { state: 'unreachable' };

/**
 * Flatten `/v1/me` for the webview's camelCase fields. A server that predates
 * credits sends only the request-era fields; they fill the credit slots so the
 * account panel still draws a bar (the number is then a call count — the
 * server side of this change ships the same day, so the mismatch is brief).
 */
export function webviewFieldsFromProfile(profile: RemoteProfile | null) {
  const creditsUsedThisWeek = profile?.credits_used_this_week ?? profile?.requests_used_this_week;
  const creditsLimitWeekly = profile?.credits_limit_weekly ?? profile?.requests_limit_weekly;
  return {
    githubLogin: profile?.github_login,
    email: profile?.email ?? undefined,
    plan: profile?.plan,
    creditsUsedThisWeek,
    creditsLimitWeekly,
    creditsUsedWindow: profile?.credits_used_window,
    creditsLimitWindow: profile?.credits_limit_window,
    windowSeconds: profile?.window_seconds,
    tokensPerCredit: profile?.tokens_per_credit,
    // Kept for any webview build still reading the old names.
    requestsUsedThisWeek: creditsUsedThisWeek,
    requestsLimitWeekly: creditsLimitWeekly,
  };
}

export function describeRemoteAuthError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('account_too_new')) {
    return 'This GitHub account is too new. WorkspaceGPT requires accounts older than 60 days.';
  }
  if (raw.includes('access_denied')) {
    return 'GitHub authorization was denied.';
  }
  if (raw.includes('oauth_failed') || raw.includes('no_code')) {
    return 'Sign-in failed. Please try again.';
  }
  return raw;
}

/** At most one loopback callback server — Settings and the Command Palette share this. */
let inFlightSignIn: RemoteSignInService | null = null;

/**
 * RECONSTRUCTED 2026-08-31 — this file was deleted by mistake earlier in the
 * same session (before it had ever been committed) and rebuilt from the
 * surrounding code's contracts (constants.ts's REMOTE_AUTH doc-comment, the
 * sign-in/out commands in extension.ts, the WebviewMessageHandler sign-in
 * gate, and this repo's existing GitHubOAuthService/OAuthCallbackServer
 * pattern for the loopback flow shape). It is functionally equivalent to the
 * original design but is NOT guaranteed byte-identical — re-verify against
 * the live apps/workspacegpt-api Worker's actual `/auth/*` responses before
 * relying on exact field names.
 *
 * Remote-mode SaaS account sign-in (apps/workspacegpt-api Worker — see
 * CLOUDFLARE-REMOTE-MODE-DESIGN.md). Unlike GitHubOAuthService, the Worker
 * mediates the entire GitHub round-trip: the extension never sees a GitHub
 * token, only holds an opaque session token minted by the Worker. Flow:
 * open `${REMOTE_AUTH.API_BASE}/auth/login?redirect_uri=<loopback>&state=`,
 * the Worker serves a branded "Continue with GitHub" page, GitHub redirects
 * to the Worker's own fixed `/auth/github/callback` (not this loopback), and
 * the Worker 302s back to `redirect_uri` with `?sessionToken=` or `?error=`.
 */
export class RemoteSignInService {
  private callbackServer: OAuthCallbackServer | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Load the stored token into the sync cache. Called once during activation,
   * before the webview can ask for a completion, so remote-mode inference has
   * a bearer token available without an async hop.
   */
  static async primeCache(context: vscode.ExtensionContext): Promise<void> {
    setCachedRemoteSessionToken(await context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN));
  }

  /** Open the browser, wait for the Worker's loopback redirect, store the session token. */
  async signIn(): Promise<void> {
    if (inFlightSignIn && inFlightSignIn !== this) inFlightSignIn.cancelSignIn();
    this.cancelSignIn();
    inFlightSignIn = this;

    try {
      const state = OAuthCallbackServer.generateState();
      const redirectUri = `http://127.0.0.1:${REMOTE_AUTH.CALLBACK_PORT}${REMOTE_AUTH.CALLBACK_PATH}`;
      this.callbackServer = new OAuthCallbackServer();

      const { params } = await this.callbackServer.waitForCallback({
        port: REMOTE_AUTH.CALLBACK_PORT,
        path: REMOTE_AUTH.CALLBACK_PATH,
        state,
        buildAuthUrl: () => {
          const qs = new URLSearchParams({ redirect_uri: redirectUri, state });
          return `${REMOTE_AUTH.API_BASE}/auth/login?${qs.toString()}`;
        },
      });
      this.callbackServer = null;

      const sessionToken = params.get('sessionToken');
      if (!sessionToken) throw new Error('No session token returned from the WorkspaceGPT server.');

      // Re-login must not leave the previous KV session alive for 30 days.
      const previous = await this.context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
      if (previous && previous !== sessionToken) {
        await this.revokeServerSession(previous);
      }

      await this.context.secrets.store(STORAGE_KEYS.REMOTE_SESSION_TOKEN, sessionToken);
      setCachedRemoteSessionToken(sessionToken);
    } finally {
      if (inFlightSignIn === this) inFlightSignIn = null;
    }
  }

  cancelSignIn(): void {
    this.callbackServer?.cancel();
    this.callbackServer = null;
  }

  /**
   * Local-only check (no network): a session token is present. Callers that
   * need to know it's still *valid* server-side should call {@link verifySession}.
   */
  async isSignedIn(): Promise<boolean> {
    return !!(await this.context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN));
  }

  /** Confirm the stored session token against the Worker and read back the account's plan + this week's usage. */
  async verifySession(): Promise<SessionVerifyResult> {
    const token = await this.context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
    if (!token) return { state: 'signed_out' };

    try {
      const response = await fetch(`${REMOTE_AUTH.API_BASE}/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        await this.clearLocalSession();
        return { state: 'signed_out' };
      }
      if (!response.ok) return { state: 'unreachable' };
      const profile = (await response.json()) as RemoteProfile;
      if (!profile?.github_login) return { state: 'unreachable' };
      return { state: 'signed_in', profile };
    } catch {
      // Network failure: keep the local token. The next inference request
      // revalidates server-side; the Settings card should not flash "signed out".
      return { state: 'unreachable' };
    }
  }

  async signOut(): Promise<void> {
    const token = await this.context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
    if (token) await this.revokeServerSession(token);
    await this.clearLocalSession();
  }

  /** Drop the local credential without talking to the Worker (already 401 / expired). */
  async clearLocalSession(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
    setCachedRemoteSessionToken(undefined);
  }

  private async revokeServerSession(token: string): Promise<void> {
    try {
      await fetch(`${REMOTE_AUTH.API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Best-effort — the Worker session will simply expire if this fails.
    }
  }
}
