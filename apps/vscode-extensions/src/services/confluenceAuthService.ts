import * as vscode from 'vscode';
import * as http from 'http';
import { ATLASSIAN_OAUTH, STORAGE_KEYS } from '../../constants';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
}

export interface ConfluenceSite {
  id: string; // cloudId
  url: string;
  name: string;
  scopes: string[];
  avatarUrl: string;
}

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
}

export class ConfluenceAuthService {
  private context: vscode.ExtensionContext;
  private server: http.Server | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Start the OAuth 2.0 (3LO) flow:
   * 1. Spin up a temporary local HTTP server to capture the callback
   * 2. Open the Atlassian consent page in the user's browser
   * 3. After consent, exchange the auth code for tokens
   * 4. Auto-discover the Confluence cloud site
   * 5. Store tokens securely
   */
  async startOAuthFlow(): Promise<{
    tokens: OAuthTokens;
    site: ConfluenceSite;
  }> {
    // Generate a random state parameter for CSRF protection
    const state = this.generateRandomState();

    // Build the authorization URL
    const authUrl = this.buildAuthUrl(state);

    // Set up the local callback server and wait for the redirect
    const code = await this.waitForAuthCode(state);

    // Exchange the authorization code for tokens
    const tokens = await this.exchangeCodeForTokens(code);

    // Discover accessible Confluence sites
    const sites = await this.getAccessibleResources(tokens.accessToken);
    if (sites.length === 0) {
      throw new Error(
        'No Confluence sites found for this account. Make sure you have access to at least one Confluence site.'
      );
    }

    // Use the first site (most users have only one)
    const site = sites[0];

    // Save tokens securely
    await this.saveTokens(tokens);

    // Save site info in global state
    await this.context.globalState.update(
      'confluence-site',
      site
    );

    return { tokens, site };
  }

  /**
   * Builds the Atlassian authorization URL with required parameters
   */
  private buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: ATLASSIAN_OAUTH.ATLASSIAN_CLIENT_ID,
      scope: ATLASSIAN_OAUTH.SCOPES.join(' '),
      redirect_uri: `http://127.0.0.1:${ATLASSIAN_OAUTH.CALLBACK_PORT}${ATLASSIAN_OAUTH.CALLBACK_PATH}`,
      state,
      response_type: 'code',
      prompt: 'consent',
    });

    return `${ATLASSIAN_OAUTH.AUTH_URL}?${params.toString()}`;
  }

  /**
   * Spins up a temporary HTTP server, opens the browser, and waits for the OAuth callback.
   * Returns the authorization code.
   */
  private waitForAuthCode(state: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Set a timeout (5 minutes)
      const timeout = setTimeout(() => {
        this.shutdownServer();
        reject(new Error('OAuth authentication timed out. Please try again.'));
      }, 5 * 60 * 1000);

      this.server = http.createServer((req, res) => {
        const url = new URL(req.url || '', `http://127.0.0.1:${ATLASSIAN_OAUTH.CALLBACK_PORT}`);

        if (url.pathname === ATLASSIAN_OAUTH.CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getErrorHtml(error));
            clearTimeout(timeout);
            this.shutdownServer();
            reject(new Error(`Atlassian authorization error: ${error}`));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getErrorHtml('State mismatch - possible CSRF attack'));
            clearTimeout(timeout);
            this.shutdownServer();
            reject(new Error('OAuth state mismatch. Please try again.'));
            return;
          }

          if (!code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getErrorHtml('No authorization code received'));
            clearTimeout(timeout);
            this.shutdownServer();
            reject(new Error('No authorization code received from Atlassian.'));
            return;
          }

          // Success!
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getSuccessHtml());
          clearTimeout(timeout);
          this.shutdownServer();
          resolve(code);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(ATLASSIAN_OAUTH.CALLBACK_PORT, '127.0.0.1', () => {
        // Open the browser for the user to authorize
        const authUrl = this.buildAuthUrl(state);
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });

      this.server.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });
  }

  /**
   * Exchange the authorization code for access and refresh tokens via proxy
   */
  private async exchangeCodeForTokens(code: string): Promise<OAuthTokens> {
    try {
      const response = await fetch(ATLASSIAN_OAUTH.TOKEN_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `http://127.0.0.1:${ATLASSIAN_OAUTH.CALLBACK_PORT}${ATLASSIAN_OAUTH.CALLBACK_PATH}`,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const { access_token, refresh_token, expires_in } = data;

      return {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + expires_in * 1000,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to exchange authorization code for tokens: ${msg}`);
    }
  }

  /**
   * Refresh the access token using the refresh token
   */
  async refreshAccessToken(): Promise<OAuthTokens> {
    const tokens = await this.getStoredTokens();
    if (!tokens?.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate with Confluence.');
    }

    try {
      const response = await fetch(ATLASSIAN_OAUTH.TOKEN_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const { access_token, refresh_token, expires_in } = data;

      const newTokens: OAuthTokens = {
        accessToken: access_token,
        refreshToken: refresh_token || tokens.refreshToken,
        expiresAt: Date.now() + expires_in * 1000,
      };

      await this.saveTokens(newTokens);
      return newTokens;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to refresh access token: ${msg}`);
    }
  }

  /**
   * Get a valid access token, refreshing if needed
   */
  async getValidAccessToken(): Promise<string> {
    let tokens = await this.getStoredTokens();
    if (!tokens) {
      throw new Error('Not authenticated with Confluence. Please connect first.');
    }

    // Refresh if token expires within 5 minutes
    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      tokens = await this.refreshAccessToken();
    }

    return tokens.accessToken;
  }

  /**
   * Fetch accessible Confluence sites for the authenticated user
   */
  async getAccessibleResources(accessToken: string): Promise<ConfluenceSite[]> {
    try {
      const response = await fetch(ATLASSIAN_OAUTH.ACCESSIBLE_RESOURCES_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed (${response.status}): ${errorText}`);
      }

      return await response.json();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch accessible resources: ${msg}`);
    }
  }

  /**
   * Fetch available Confluence spaces for a given cloud site
   */
  async fetchSpaces(cloudId: string): Promise<ConfluenceSpace[]> {
    const accessToken = await this.getValidAccessToken();

    let allSpaces: any[] = [];
    // The v2 API may omit personal spaces by default, so we explicitly request both global and personal,
    // and only currently active spaces.
    let nextUrl: string | null = `https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/spaces?limit=250&type=global&type=personal&status=current`;

    try {
      while (nextUrl) {
        const response = await fetch(nextUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        allSpaces = allSpaces.concat(data.results);

        // Check if there is a next page
        if (data._links && data._links.next) {
          // The next link returned by API v2 is usually a relative path like /wiki/api/v2/spaces?cursor=...
          // We need to append it to the Atlassian proxy base URL
          const nextPath = data._links.next;
          nextUrl = `https://api.atlassian.com/ex/confluence/${cloudId}${nextPath}`;
        } else {
          nextUrl = null;
        }
      }

      const mappedSpaces = allSpaces.map((space: any) => ({
        id: space.id,
        key: space.key,
        name: space.name,
        type: space.type,
        status: space.status,
      }));

      // Sort alphabetically by space name
      return mappedSpaces.sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch Confluence spaces: ${msg}`);
    }
  }

  /**
   * Disconnect: clear all stored tokens and site info
   */
  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.CONFLUENCE_OAUTH_TOKENS);
    await this.context.globalState.update('confluence-site', undefined);
  }

  /**
   * Check if user is currently authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const tokens = await this.getStoredTokens();
    return tokens !== null;
  }

  /**
   * Get stored site info
   */
  getStoredSite(): ConfluenceSite | undefined {
    return this.context.globalState.get<ConfluenceSite>('confluence-site');
  }

  // --- Private Helpers ---

  private async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.context.secrets.store(
      STORAGE_KEYS.CONFLUENCE_OAUTH_TOKENS,
      JSON.stringify(tokens)
    );
  }

  async getStoredTokens(): Promise<OAuthTokens | null> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.CONFLUENCE_OAUTH_TOKENS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthTokens;
    } catch {
      return null;
    }
  }

  private shutdownServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  private generateRandomState(): string {
    const array = new Uint8Array(32);
    require('crypto').randomFillSync(array);
    return Array.from(array, (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  private getSuccessHtml(): string {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WorkspaceGPT - Connected!</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 40px; background: #16213e; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
    <div style="font-size: 64px; margin-bottom: 16px;">✅</div>
    <h1 style="color: #4ecca3; margin-bottom: 8px;">Connected to Confluence!</h1>
    <p style="color: #a0a0a0;">You can close this tab and return to VS Code.</p>
  </div>
</body>
</html>`;
  }

  private getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>WorkspaceGPT - Error</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 40px; background: #16213e; border-radius: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
    <div style="font-size: 64px; margin-bottom: 16px;">❌</div>
    <h1 style="color: #e74c3c; margin-bottom: 8px;">Authentication Failed</h1>
    <p style="color: #a0a0a0;">${error}</p>
    <p style="color: #a0a0a0;">Please close this tab and try again in VS Code.</p>
  </div>
</body>
</html>`;
  }
}
