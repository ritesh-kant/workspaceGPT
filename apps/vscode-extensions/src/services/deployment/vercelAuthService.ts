import * as vscode from 'vscode';
import { VERCEL_OAUTH, STORAGE_KEYS } from '../../../constants';
import { OAuthCallbackServer } from './oauthCallbackServer';

export interface VercelTokens {
  accessToken: string;
  /** Present when the integration was installed on a team. */
  teamId?: string;
  connectedAt: number;
}

/**
 * Vercel OAuth integration auth for deployment writes (frontend env vars).
 *
 * Standard OAuth code flow via the loopback callback; the code is exchanged for
 * an access token through the proxy (which holds the client_secret). Vercel
 * integration tokens are long-lived per install — there is no refresh grant, so
 * re-connecting is the recovery path if a token is revoked.
 */
export class VercelAuthService {
  private callbackServer: OAuthCallbackServer | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async startOAuthFlow(): Promise<VercelTokens> {
    if (VERCEL_OAUTH.INTEGRATION_SLUG.startsWith('REPLACE_WITH')) {
      throw new Error(
        'Vercel integration is not configured yet. Set VERCEL_OAUTH.INTEGRATION_SLUG in constants after registering the integration.',
      );
    }

    // Tear down any prior pending flow so its server releases the port.
    this.cancelOAuthFlow();

    const state = OAuthCallbackServer.generateState();
    const redirectUri = `http://127.0.0.1:${VERCEL_OAUTH.CALLBACK_PORT}${VERCEL_OAUTH.CALLBACK_PATH}`;
    this.callbackServer = new OAuthCallbackServer();

    const { params } = await this.callbackServer.waitForCallback({
      port: VERCEL_OAUTH.CALLBACK_PORT,
      path: VERCEL_OAUTH.CALLBACK_PATH,
      state,
      buildAuthUrl: () =>
        `${VERCEL_OAUTH.AUTH_BASE_URL}/${VERCEL_OAUTH.INTEGRATION_SLUG}/new?state=${state}`,
    });
    this.callbackServer = null;

    const code = params.get('code');
    if (!code) {
      throw new Error('No authorization code returned from Vercel.');
    }

    const tokens = await this.exchangeCode(code, redirectUri);
    await this.saveTokens(tokens);
    return tokens;
  }

  cancelOAuthFlow(): void {
    this.callbackServer?.cancel();
    this.callbackServer = null;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<VercelTokens> {
    const response = await fetch(VERCEL_OAUTH.TOKEN_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Vercel token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { access_token: string; team_id?: string };
    return {
      accessToken: data.access_token,
      teamId: data.team_id,
      connectedAt: Date.now(),
    };
  }

  async getValidAccessToken(): Promise<string> {
    const tokens = await this.getStoredTokens();
    if (!tokens) {
      throw new Error('Not connected to Vercel. Please connect first.');
    }
    return tokens.accessToken;
  }

  async getStoredTokens(): Promise<VercelTokens | null> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.VERCEL_OAUTH_TOKENS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VercelTokens;
    } catch {
      return null;
    }
  }

  async isConnected(): Promise<boolean> {
    return (await this.getStoredTokens()) !== null;
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.VERCEL_OAUTH_TOKENS);
  }

  private async saveTokens(tokens: VercelTokens): Promise<void> {
    await this.context.secrets.store(STORAGE_KEYS.VERCEL_OAUTH_TOKENS, JSON.stringify(tokens));
  }
}
