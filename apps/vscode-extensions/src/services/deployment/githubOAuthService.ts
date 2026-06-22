import * as vscode from 'vscode';
import { GITHUB_OAUTH, STORAGE_KEYS } from '../../../constants';
import { OAuthCallbackServer } from './oauthCallbackServer';

export interface GitHubOAuthTokens {
  accessToken: string;
  /** Present only if the OAuth App has token expiration enabled. */
  refreshToken?: string;
  /** Unix ms; undefined for non-expiring tokens. */
  expiresAt?: number;
  scope?: string;
  connectedAt: number;
}

/**
 * GitHub OAuth App auth for deployment writes — the "Authorize WorkspaceGPT"
 * consent flow. Same shape as ConfluenceAuthService: open the authorize URL,
 * capture `code` on the loopback callback, exchange via the proxy (which holds
 * the client_secret). The token acts as the user; write creds stay in
 * SecretStorage and are never shared to the Chrome extension.
 */
export class GitHubOAuthService {
  private callbackServer: OAuthCallbackServer | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async startOAuthFlow(): Promise<GitHubOAuthTokens> {
    if (GITHUB_OAUTH.CLIENT_ID.startsWith('REPLACE_WITH')) {
      throw new Error(
        'GitHub OAuth App is not configured yet. Set GITHUB_OAUTH.CLIENT_ID in constants after registering the OAuth App.',
      );
    }

    // Tear down any prior pending flow so its server releases the port.
    this.cancelOAuthFlow();

    const state = OAuthCallbackServer.generateState();
    const redirectUri = `http://127.0.0.1:${GITHUB_OAUTH.CALLBACK_PORT}${GITHUB_OAUTH.CALLBACK_PATH}`;
    this.callbackServer = new OAuthCallbackServer();

    const { params } = await this.callbackServer.waitForCallback({
      port: GITHUB_OAUTH.CALLBACK_PORT,
      path: GITHUB_OAUTH.CALLBACK_PATH,
      state,
      buildAuthUrl: () => {
        const qs = new URLSearchParams({
          client_id: GITHUB_OAUTH.CLIENT_ID,
          redirect_uri: redirectUri,
          scope: GITHUB_OAUTH.SCOPES.join(' '),
          state,
        });
        return `${GITHUB_OAUTH.AUTH_URL}?${qs.toString()}`;
      },
    });
    this.callbackServer = null;

    const code = params.get('code');
    if (!code) throw new Error('No authorization code returned from GitHub.');

    const tokens = await this.exchangeCode(code, redirectUri);
    await this.saveTokens(tokens);
    return tokens;
  }

  cancelOAuthFlow(): void {
    this.callbackServer?.cancel();
    this.callbackServer = null;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<GitHubOAuthTokens> {
    const data = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    return this.toTokens(data);
  }

  /** Refresh — only applicable when the OAuth App has token expiration enabled. */
  private async refresh(refreshToken: string): Promise<GitHubOAuthTokens> {
    const data = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const tokens = this.toTokens(data);
    // GitHub returns a fresh refresh_token on rotation; fall back to the old one.
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    await this.saveTokens(tokens);
    return tokens;
  }

  private async tokenRequest(body: Record<string, string>): Promise<any> {
    const response = await fetch(GITHUB_OAUTH.TOKEN_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub token request failed (${response.status}): ${text}`);
    }
    return response.json();
  }

  private toTokens(data: any): GitHubOAuthTokens {
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : undefined,
      scope: data.scope,
      connectedAt: Date.now(),
    };
  }

  /** Valid token, refreshing first if it expires within 5 minutes (when refreshable). */
  async getValidAccessToken(): Promise<string> {
    const tokens = await this.getStoredTokens();
    if (!tokens) throw new Error('Not connected to GitHub. Please authorize first.');

    const expiringSoon =
      tokens.expiresAt !== undefined && Date.now() > tokens.expiresAt - 5 * 60 * 1000;
    if (expiringSoon && tokens.refreshToken) {
      const refreshed = await this.refresh(tokens.refreshToken);
      return refreshed.accessToken;
    }
    return tokens.accessToken;
  }

  async getStoredTokens(): Promise<GitHubOAuthTokens | null> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.GITHUB_OAUTH_TOKENS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GitHubOAuthTokens;
    } catch {
      return null;
    }
  }

  async isConnected(): Promise<boolean> {
    return (await this.getStoredTokens()) !== null;
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.GITHUB_OAUTH_TOKENS);
  }

  private async saveTokens(tokens: GitHubOAuthTokens): Promise<void> {
    await this.context.secrets.store(STORAGE_KEYS.GITHUB_OAUTH_TOKENS, JSON.stringify(tokens));
  }
}
