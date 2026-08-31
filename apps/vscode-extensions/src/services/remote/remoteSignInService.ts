import * as vscode from 'vscode';
import { REMOTE_AUTH, STORAGE_KEYS } from '../../../constants';
import { OAuthCallbackServer } from '../deployment/oauthCallbackServer';
import { setCachedRemoteSessionToken } from './remoteSessionCache';

export interface RemoteProfile {
  github_login: string;
  plan?: string;
  status?: string;
  requests_used_today?: number;
  requests_limit_daily?: number;
}

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
    this.cancelSignIn();

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

    await this.context.secrets.store(STORAGE_KEYS.REMOTE_SESSION_TOKEN, sessionToken);
    setCachedRemoteSessionToken(sessionToken);
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

  /** Confirm the stored session token against the Worker and read back the account's plan + today's usage. */
  async verifySession(): Promise<RemoteProfile | null> {
    const token = await this.context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
    if (!token) return null;

    try {
      const response = await fetch(`${REMOTE_AUTH.API_BASE}/v1/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;
      return (await response.json()) as RemoteProfile;
    } catch {
      // Network failure. Nothing is cached optimistically: the next inference
      // request revalidates server-side anyway, so a transient failure here
      // only makes the Settings card read "not signed in" until it retries.
      return null;
    }
  }

  async signOut(): Promise<void> {
    const token = await this.context.secrets.get(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
    if (token) {
      try {
        await fetch(`${REMOTE_AUTH.API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        // Best-effort — the Worker session will simply expire if this fails.
      }
    }
    await this.context.secrets.delete(STORAGE_KEYS.REMOTE_SESSION_TOKEN);
    setCachedRemoteSessionToken(undefined);
  }
}
