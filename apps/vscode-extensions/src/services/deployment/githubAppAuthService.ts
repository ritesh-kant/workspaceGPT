import * as vscode from 'vscode';
import { GITHUB_APP, STORAGE_KEYS } from '../../../constants';
import { OAuthCallbackServer } from './oauthCallbackServer';

export interface GitHubInstallation {
  installationId: string;
  /** When the user connected, for display. */
  connectedAt: number;
}

interface InstallationTokenCache {
  token: string;
  /** Unix ms. */
  expiresAt: number;
}

/**
 * GitHub App auth (server-to-server) for deployment writes.
 *
 * "Connect" = install the App on the target repos; we capture the
 * `installation_id` from the post-install loopback redirect. Tokens are then
 * *minted* on demand by the proxy (which holds the App private key) — short
 * lived (~1h) and cached until shortly before expiry. The extension never holds
 * the private key, and these tokens are kept out of the Chrome share bundle.
 */
export class GitHubAppAuthService {
  private callbackServer: OAuthCallbackServer | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Run the install flow and persist the resulting installation id. */
  async startInstallFlow(): Promise<GitHubInstallation> {
    if (GITHUB_APP.APP_SLUG.startsWith('REPLACE_WITH')) {
      throw new Error(
        'GitHub App is not configured yet. Set GITHUB_APP.APP_SLUG in constants after registering the App.',
      );
    }

    const state = OAuthCallbackServer.generateState();
    this.callbackServer = new OAuthCallbackServer();

    const { params } = await this.callbackServer.waitForCallback({
      port: GITHUB_APP.CALLBACK_PORT,
      path: GITHUB_APP.CALLBACK_PATH,
      state,
      buildAuthUrl: () =>
        `${GITHUB_APP.INSTALL_BASE_URL}/${GITHUB_APP.APP_SLUG}/installations/new?state=${state}`,
    });
    this.callbackServer = null;

    const installationId = params.get('installation_id');
    if (!installationId) {
      throw new Error('No installation_id returned from GitHub. Did the install complete?');
    }

    const installation: GitHubInstallation = {
      installationId,
      connectedAt: Date.now(),
    };
    await this.context.secrets.store(
      STORAGE_KEYS.GITHUB_APP_INSTALLATION,
      JSON.stringify(installation),
    );
    // Drop any stale token cached against a previous installation.
    await this.context.secrets.delete(STORAGE_KEYS.GITHUB_INSTALLATION_TOKEN_CACHE);

    return installation;
  }

  cancelInstallFlow(): void {
    this.callbackServer?.cancel();
    this.callbackServer = null;
  }

  async getInstallation(): Promise<GitHubInstallation | null> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.GITHUB_APP_INSTALLATION);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GitHubInstallation;
    } catch {
      return null;
    }
  }

  async isConnected(): Promise<boolean> {
    return (await this.getInstallation()) !== null;
  }

  /**
   * Return a valid installation token, minting a fresh one via the proxy when
   * none is cached or the cached one is within 5 minutes of expiry.
   *
   * @param repositories optional repo names to scope the token below the
   *   installation's full grant (least privilege).
   */
  async getValidToken(repositories?: string[]): Promise<string> {
    const cached = await this.getCachedToken();
    if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
      return cached.token;
    }
    return this.mintToken(repositories);
  }

  private async mintToken(repositories?: string[]): Promise<string> {
    const installation = await this.getInstallation();
    if (!installation) {
      throw new Error('Not connected to GitHub. Please install the GitHub App first.');
    }

    const response = await fetch(GITHUB_APP.INSTALLATION_TOKEN_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installation_id: installation.installationId,
        ...(repositories && repositories.length > 0 ? { repositories } : {}),
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to mint GitHub installation token (${response.status}): ${text}`);
    }

    const data = (await response.json()) as { token: string; expires_at: string };
    const cache: InstallationTokenCache = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };
    await this.context.secrets.store(
      STORAGE_KEYS.GITHUB_INSTALLATION_TOKEN_CACHE,
      JSON.stringify(cache),
    );
    return cache.token;
  }

  private async getCachedToken(): Promise<InstallationTokenCache | null> {
    const raw = await this.context.secrets.get(STORAGE_KEYS.GITHUB_INSTALLATION_TOKEN_CACHE);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InstallationTokenCache;
    } catch {
      return null;
    }
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.GITHUB_APP_INSTALLATION);
    await this.context.secrets.delete(STORAGE_KEYS.GITHUB_INSTALLATION_TOKEN_CACHE);
  }
}
