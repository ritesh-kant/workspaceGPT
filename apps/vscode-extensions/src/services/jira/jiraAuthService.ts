import * as vscode from 'vscode';
import * as http from 'http';
import { JIRA_OAUTH, STORAGE_KEYS } from '../../../constants';

/**
 * Jira Cloud auth — OAuth 2.0 (3LO), mirroring confluenceAuthService.ts's
 * flow exactly: same Atlassian app, same token-exchange proxy, same
 * accessible-resources site discovery. Replaced the original API-token
 * (Basic email:token) flow post-P9 — see JIRA-INTEGRATION-DESIGN.md §5 P2
 * for that flow's rationale at the time; OAuth turned out to need no new
 * backend, since Confluence's proxy already forwards any Atlassian
 * grant_type/code/refresh_token regardless of product or scope.
 *
 * Deliberately NOT shared with ConfluenceAuthService via a base class: the
 * two are near-identical mechanically, but this codebase's own precedent
 * (jiraService.ts vs adoService.ts, jiraSyncScheduler.ts vs
 * adoSyncScheduler.ts) is to mirror rather than abstract across providers,
 * and refactoring Confluence's already-shipped, working OAuth code was not
 * asked for here.
 *
 * A key difference from Confluence: Confluence Cloud's REST API is fetched
 * through this file's callers going straight to `${cloudId}`-scoped urls
 * under `api.atlassian.com/ex/confluence/...`; Jira's equivalent base is
 * `https://api.atlassian.com/ex/jira/{cloudId}` (see jiraApiBase below) —
 * every Jira REST call in this package must go through that proxy path with
 * a `Bearer` token now, never the site's own domain with `Basic` auth. The
 * site's own domain (JiraSite.url) is kept only for building human-facing
 * `/browse/{key}` links.
 */

export interface JiraOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in ms
}

export interface JiraSite {
  id: string; // cloudId
  url: string;
  name: string;
  scopes: string[];
  avatarUrl: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  /** Jira's own REST self-link for the project — mirrors AdoProject.url, which is also an API url, not a browse url. */
  url: string;
}

export interface JiraIdentity {
  accountId: string;
  displayName: string;
}

/** `https://api.atlassian.com/ex/jira/{cloudId}` — the base every OAuth-authenticated Jira REST call goes through. */
export function jiraApiBase(cloudId: string): string {
  return `https://api.atlassian.com/ex/jira/${cloudId}`;
}

async function jiraGet(url: string, authHeader: string, what: string): Promise<any> {
  const response = await fetch(url, { headers: { Authorization: authHeader, Accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Jira rejected the request — the connection may have expired or lost permission. Reconnect Jira in Settings.');
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Could not ${what} (${response.status}): ${body.slice(0, 200)}`);
  }
  return response.json();
}

export class JiraAuthService {
  private context: vscode.ExtensionContext;
  private server: http.Server | null = null;
  private pendingReject: ((reason?: any) => void) | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Start the OAuth 2.0 (3LO) flow:
   * 1. Spin up a temporary local HTTP server to capture the callback
   * 2. Open the Atlassian consent page in the user's browser
   * 3. After consent, exchange the auth code for tokens
   * 4. Auto-discover the Jira cloud site, and fetch the account identity
   * 5. Store tokens securely
   */
  async startOAuthFlow(): Promise<{ tokens: JiraOAuthTokens; site: JiraSite; identity: JiraIdentity }> {
    const state = this.generateRandomState();
    const code = await this.waitForAuthCode(state);
    const tokens = await this.exchangeCodeForTokens(code);

    const sites = await this.getAccessibleResources(tokens.accessToken);
    if (sites.length === 0) {
      throw new Error('No Jira sites found for this account. Make sure you have access to at least one Jira site.');
    }
    const site = sites[0];

    await this.saveTokens(tokens);
    await this.context.globalState.update('jira-site', site);

    const me = await jiraGet(`${jiraApiBase(site.id)}/rest/api/3/myself`, `Bearer ${tokens.accessToken}`, 'fetch Jira account identity');
    const identity: JiraIdentity = { accountId: me?.accountId, displayName: me?.displayName || site.name };

    return { tokens, site, identity };
  }

  private buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: JIRA_OAUTH.ATLASSIAN_CLIENT_ID,
      scope: JIRA_OAUTH.SCOPES.join(' '),
      redirect_uri: `http://127.0.0.1:${JIRA_OAUTH.CALLBACK_PORT}${JIRA_OAUTH.CALLBACK_PATH}`,
      state,
      response_type: 'code',
      prompt: 'consent',
    });

    return `${JIRA_OAUTH.AUTH_URL}?${params.toString()}`;
  }

  /**
   * Spins up a temporary HTTP server, opens the browser, and waits for the OAuth callback.
   * Returns the authorization code.
   */
  private waitForAuthCode(state: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.timeout = setTimeout(() => {
        this.clearPendingReject();
        this.shutdownServer();
        reject(new Error('OAuth authentication timed out. Please try again.'));
      }, 5 * 60 * 1000);

      this.pendingReject = reject;

      this.server = http.createServer((req, res) => {
        const url = new URL(req.url || '', `http://127.0.0.1:${JIRA_OAUTH.CALLBACK_PORT}`);

        if (url.pathname === JIRA_OAUTH.CALLBACK_PATH) {
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getErrorHtml(error));
            this.clearTimeout();
            this.clearPendingReject();
            this.shutdownServer();
            reject(new Error(`Atlassian authorization error: ${error}`));
            return;
          }

          if (returnedState !== state) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getErrorHtml('State mismatch - possible CSRF attack'));
            this.clearTimeout();
            this.clearPendingReject();
            this.shutdownServer();
            reject(new Error('OAuth state mismatch. Please try again.'));
            return;
          }

          if (!code) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getErrorHtml('No authorization code received'));
            this.clearTimeout();
            this.clearPendingReject();
            this.shutdownServer();
            reject(new Error('No authorization code received from Atlassian.'));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(this.getSuccessHtml());
          this.clearTimeout();
          this.clearPendingReject();
          this.shutdownServer();
          resolve(code);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(JIRA_OAUTH.CALLBACK_PORT, '127.0.0.1', () => {
        const authUrl = this.buildAuthUrl(state);
        vscode.env.openExternal(vscode.Uri.parse(authUrl));
      });

      this.server.on('error', (err) => {
        this.clearTimeout();
        this.clearPendingReject();
        this.shutdownServer();
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });
  }

  private async exchangeCodeForTokens(code: string): Promise<JiraOAuthTokens> {
    try {
      const response = await fetch(JIRA_OAUTH.TOKEN_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `http://127.0.0.1:${JIRA_OAUTH.CALLBACK_PORT}${JIRA_OAUTH.CALLBACK_PATH}`,
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

  async refreshAccessToken(): Promise<JiraOAuthTokens> {
    const tokens = await this.getStoredTokens();
    if (!tokens?.refreshToken) {
      throw new Error('No refresh token available. Please re-authenticate with Jira.');
    }

    try {
      const response = await fetch(JIRA_OAUTH.TOKEN_PROXY_URL, {
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

      const newTokens: JiraOAuthTokens = {
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

  async getValidAccessToken(): Promise<string> {
    let tokens = await this.getStoredTokens();
    if (!tokens) {
      throw new Error('Not authenticated with Jira. Please connect first.');
    }

    if (Date.now() > tokens.expiresAt - 5 * 60 * 1000) {
      tokens = await this.refreshAccessToken();
    }

    return tokens.accessToken;
  }

  /** `Bearer <access token>` — every Jira REST call needs this. */
  async getValidAuthHeader(): Promise<string> {
    return `Bearer ${await this.getValidAccessToken()}`;
  }

  /** Accessible Atlassian sites for the authenticated user (same identity endpoint Confluence's OAuth uses — product-agnostic). */
  async getAccessibleResources(accessToken: string): Promise<JiraSite[]> {
    try {
      const response = await fetch(JIRA_OAUTH.ACCESSIBLE_RESOURCES_URL, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
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
   * Projects visible to this account, alphabetical. Paginates `project/search`
   * (the current, non-deprecated endpoint) until `isLast` — a site with more
   * than one page of projects is not rare the way it would be for ADO's
   * org→project list.
   */
  async fetchProjects(cloudId: string): Promise<JiraProject[]> {
    const authHeader = await this.getValidAuthHeader();
    const projects: JiraProject[] = [];
    let startAt = 0;
    const maxResults = 50;

    for (;;) {
      const url = `${jiraApiBase(cloudId)}/rest/api/3/project/search?maxResults=${maxResults}&startAt=${startAt}&orderBy=name`;
      const page = await jiraGet(url, authHeader, 'fetch Jira projects');
      for (const p of page?.values ?? []) {
        projects.push({ id: String(p.id), key: p.key, name: p.name, url: p.self });
      }
      if (page?.isLast !== false || !page?.values?.length) break;
      startAt += maxResults;
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Re-validates the stored token against `/myself` — the "Check connection" action. */
  async checkConnection(): Promise<JiraIdentity> {
    const site = this.getStoredSite();
    if (!site) {
      throw new Error('Jira is not connected.');
    }
    const authHeader = await this.getValidAuthHeader();
    const me = await jiraGet(`${jiraApiBase(site.id)}/rest/api/3/myself`, authHeader, 'verify Jira connection');
    const accountId = me?.accountId;
    if (!accountId) {
      throw new Error('Jira did not return an account id.');
    }
    return { accountId, displayName: me?.displayName || site.name };
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.JIRA_OAUTH_TOKENS);
    await this.context.globalState.update('jira-site', undefined);
  }

  async cancelOAuthFlow(): Promise<void> {
    this.clearTimeout();
    if (this.pendingReject) {
      this.pendingReject(new Error('Authentication cancelled.'));
      this.clearPendingReject();
    }
    this.shutdownServer();
  }

  async isAuthenticated(): Promise<boolean> {
    const tokens = await this.getStoredTokens();
    return tokens !== null;
  }

  getStoredSite(): JiraSite | undefined {
    return this.context.globalState.get<JiraSite>('jira-site');
  }

  // --- Private Helpers ---

  private async saveTokens(tokens: JiraOAuthTokens): Promise<void> {
    await this.context.secrets.store(STORAGE_KEYS.JIRA_OAUTH_TOKENS, JSON.stringify(tokens));
  }

  private async getStoredTokens(): Promise<JiraOAuthTokens | null> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.JIRA_OAUTH_TOKENS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as JiraOAuthTokens;
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

  private clearPendingReject(): void {
    this.pendingReject = null;
  }

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
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
    <h1 style="color: #4ecca3; margin-bottom: 8px;">Connected to Jira!</h1>
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
    <p style="color: #a0a0a0;">${this.escapeHtml(error)}</p>
    <p style="color: #a0a0a0;">Please close this tab and try again in VS Code.</p>
  </div>
</body>
</html>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
