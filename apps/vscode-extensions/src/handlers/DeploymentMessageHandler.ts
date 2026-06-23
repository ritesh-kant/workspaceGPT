import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { AnalyticsService } from '../services/analyticsService';
import { GitHubOAuthService } from '../services/deployment/githubOAuthService';
import { VercelAuthService } from '../services/deployment/vercelAuthService';
import { ConfluenceAuthService } from '../services/confluence/confluenceAuthService';
import { ConfluenceReleaseSource } from '../services/deployment/confluenceReleaseSource';

/**
 * Handles the deployment-automation provider connections (GitHub App + Vercel)
 * surfaced in Settings → Deployment. These are write-scoped credentials, held
 * only in the VS Code master and never included in the Chrome share bundle.
 */
export class DeploymentMessageHandler {
  private githubAuth: GitHubOAuthService;
  private vercelAuth: VercelAuthService;
  private confluenceAuth: ConfluenceAuthService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService,
  ) {
    this.githubAuth = new GitHubOAuthService(this.context);
    this.vercelAuth = new VercelAuthService(this.context);
    this.confluenceAuth = new ConfluenceAuthService(this.context);
  }

  /** Cancel any in-flight connect flow so its callback server releases the port. */
  public dispose(): void {
    this.githubAuth.cancelOAuthFlow();
    this.vercelAuth.cancelOAuthFlow();
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.CHECK_GITHUB_CONNECTION:
        await this.postGitHubStatus();
        return true;
      case MESSAGE_TYPES.START_GITHUB_INSTALL:
        this.analyticsService.trackEvent('github_install_started');
        await this.handleStartGitHubInstall();
        return true;
      case MESSAGE_TYPES.CANCEL_GITHUB_INSTALL:
        this.githubAuth.cancelOAuthFlow();
        return true;
      case MESSAGE_TYPES.DISCONNECT_GITHUB:
        this.analyticsService.trackEvent('github_disconnected');
        await this.githubAuth.disconnect();
        await this.postGitHubStatus();
        return true;

      case MESSAGE_TYPES.CHECK_VERCEL_CONNECTION:
        await this.postVercelStatus();
        return true;
      case MESSAGE_TYPES.START_VERCEL_OAUTH:
        this.analyticsService.trackEvent('vercel_oauth_started');
        await this.handleStartVercelOAuth();
        return true;
      case MESSAGE_TYPES.CANCEL_VERCEL_OAUTH:
        this.vercelAuth.cancelOAuthFlow();
        return true;
      case MESSAGE_TYPES.DISCONNECT_VERCEL:
        this.analyticsService.trackEvent('vercel_disconnected');
        await this.vercelAuth.disconnect();
        await this.postVercelStatus();
        return true;

      case MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS:
        await this.handleTestConnections();
        return true;

      case MESSAGE_TYPES.RESOLVE_RELEASE:
        await this.handleResolveRelease();
        return true;
      case MESSAGE_TYPES.GET_RELEASE_RUNS:
        await this.handleGetReleaseRuns();
        return true;
      case MESSAGE_TYPES.PREPARE_CONFIG_SYNC:
        this.analyticsService.trackEvent('config_sync_prepared');
        await this.handlePrepareConfigSync(data);
        return true;
    }
    return false;
  }

  /**
   * Resolve "today's release" for the Releases view via the Confluence
   * `ReleaseSource` (roster page → today's date → version + env + pilot). This
   * is read-only and touches nothing live. Reports `configured: false` with a
   * `reason` whenever it can't resolve, so the UI shows an honest empty state
   * instead of fabricating data.
   */
  private async handleResolveRelease(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const notConfigured = (reason: string) =>
      this.post(MESSAGE_TYPES.RESOLVE_RELEASE_RESPONSE, { configured: false, date: today, reason });

    try {
      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const rosterPageUrl: string | undefined = settings?.state?.config?.deployment?.rosterPageUrl;

      // Source of truth for "Confluence connected" is the stored OAuth tokens +
      // site (the webview `confluence.isConnected` flag isn't reliably set).
      const confluenceConnected =
        (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();

      if (!confluenceConnected) {
        return notConfigured('Connect Confluence (Settings → Confluence) to resolve releases.');
      }
      if (!rosterPageUrl) {
        return notConfigured('Set the Release Roster page URL in Settings → Deployment Automation.');
      }

      const source = new ConfluenceReleaseSource(this.confluenceAuth, { rosterPageUrl });
      const resolved = await source.resolveRelease(today);
      if (!resolved) {
        return notConfigured(`No release scheduled for ${today} on the roster.`);
      }

      this.post(MESSAGE_TYPES.RESOLVE_RELEASE_RESPONSE, {
        configured: true,
        date: resolved.date ?? today,
        version: resolved.version,
        environment: resolved.environment,
        pilot: resolved.pilot,
        pageUrl: resolved.pageUrl,
      });
    } catch (error) {
      notConfigured(errMessage(error));
    }
  }

  /** Recent release runs from the audit log. Empty until the apply flow exists. */
  private async handleGetReleaseRuns(): Promise<void> {
    this.post(MESSAGE_TYPES.GET_RELEASE_RUNS_RESPONSE, { runs: [] });
  }

  /**
   * Extract + preview the desired config for a resolved release. This is the
   * read-only first half of step d: it parses the release page's Configurations
   * table into desired config vars and returns them for review. It performs NO
   * live reads of Vercel/mach and writes nothing — the diff/apply targets land
   * in a later increment (open items #1/#3/#4).
   */
  private async handlePrepareConfigSync(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.PREPARE_CONFIG_SYNC_RESPONSE, { ok: false, error });

    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      if (!version) return fail('No release version to prepare. Resolve a release first.');

      const connected =
        (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();
      if (!connected) return fail('Connect Confluence (Settings → Confluence) first.');

      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const rosterPageUrl: string = settings?.state?.config?.deployment?.rosterPageUrl ?? '';

      const source = new ConfluenceReleaseSource(this.confluenceAuth, { rosterPageUrl });
      const vars = await source.fetchDesiredConfig(version, environment);

      this.post(MESSAGE_TYPES.PREPARE_CONFIG_SYNC_RESPONSE, {
        ok: true,
        version,
        environment,
        vars,
      });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    this.webviewView.webview.postMessage({ type, ...payload });
  }

  // --- GitHub ---

  private async handleStartGitHubInstall(): Promise<void> {
    try {
      const tokens = await this.githubAuth.startOAuthFlow();
      this.post(MESSAGE_TYPES.GITHUB_INSTALL_SUCCESS, { scope: tokens.scope });
      await this.postGitHubStatus();
    } catch (error) {
      this.post(MESSAGE_TYPES.GITHUB_INSTALL_ERROR, { error: errMessage(error) });
    }
  }

  private async postGitHubStatus(): Promise<void> {
    const tokens = await this.githubAuth.getStoredTokens();
    this.post(MESSAGE_TYPES.GITHUB_CONNECTION_STATUS, {
      connected: tokens !== null,
      scope: tokens?.scope,
      connectedAt: tokens?.connectedAt,
    });
  }

  // --- Vercel ---

  private async handleStartVercelOAuth(): Promise<void> {
    try {
      const tokens = await this.vercelAuth.startOAuthFlow();
      this.post(MESSAGE_TYPES.VERCEL_OAUTH_SUCCESS, { teamId: tokens.teamId });
      await this.postVercelStatus();
    } catch (error) {
      this.post(MESSAGE_TYPES.VERCEL_OAUTH_ERROR, { error: errMessage(error) });
    }
  }

  private async postVercelStatus(): Promise<void> {
    const tokens = await this.vercelAuth.getStoredTokens();
    this.post(MESSAGE_TYPES.VERCEL_CONNECTION_STATUS, {
      connected: tokens !== null,
      teamId: tokens?.teamId,
      connectedAt: tokens?.connectedAt,
    });
  }

  // --- Test all connections ---

  /**
   * Liveness check before a release night: confirm each connected provider's
   * token actually works (mint a GitHub token, call Vercel's whoami) rather than
   * just checking that something is stored. Reports per-provider results.
   */
  private async handleTestConnections(): Promise<void> {
    const results: Record<string, { ok: boolean; detail?: string }> = {};

    if (await this.githubAuth.isConnected()) {
      try {
        const token = await this.githubAuth.getValidAccessToken();
        const res = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'workspacegpt',
          },
        });
        results.github = res.ok
          ? { ok: true }
          : { ok: false, detail: `GitHub API ${res.status}` };
      } catch (error) {
        results.github = { ok: false, detail: errMessage(error) };
      }
    } else {
      results.github = { ok: false, detail: 'Not connected' };
    }

    if (await this.vercelAuth.isConnected()) {
      try {
        const tokens = await this.vercelAuth.getStoredTokens();
        const token = await this.vercelAuth.getValidAccessToken();
        // Integration tokens are scoped to a team/installation and have no
        // personal-user context, so `/v2/user` 404s. Probe `/v9/projects`
        // (scoped by teamId when present) — the access this feature actually
        // uses to write frontend env vars.
        const url = new URL('https://api.vercel.com/v9/projects');
        url.searchParams.set('limit', '1');
        if (tokens?.teamId) url.searchParams.set('teamId', tokens.teamId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        results.vercel = res.ok
          ? { ok: true }
          : { ok: false, detail: `Vercel API ${res.status}` };
      } catch (error) {
        results.vercel = { ok: false, detail: errMessage(error) };
      }
    } else {
      results.vercel = { ok: false, detail: 'Not connected' };
    }

    this.post(MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS_RESULT, { results });
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
