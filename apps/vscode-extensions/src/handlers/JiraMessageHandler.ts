import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { JiraAuthService } from '../services/jira/jiraAuthService';
import { AnalyticsService } from '../services/analyticsService';

/**
 * Jira Cloud connect/discovery — JIRA-INTEGRATION-DESIGN.md §5 P7.
 *
 * Deliberately smaller than AdoMessageHandler: no sync/indexing cases (§5
 * P5), no My Work fetch (§5 P6), no pre-warm step (nothing to warm — there is
 * no search worker for Jira yet). Grows alongside those features, not ahead
 * of them; see the MESSAGE_TYPES comment in constants.ts for the same point.
 */
export class JiraMessageHandler {
  private jiraAuthService: JiraAuthService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.jiraAuthService = new JiraAuthService(this.context);
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.SAVE_JIRA_CREDENTIALS:
        await this.handleSaveCredentials(data.siteUrl, data.email, data.apiToken);
        return true;
      case MESSAGE_TYPES.DISCONNECT_JIRA:
        this.analyticsService.trackEvent('jira_disconnected');
        await this.handleDisconnect();
        return true;
      case MESSAGE_TYPES.FETCH_JIRA_PROJECTS:
        await this.handleFetchProjects(data.siteUrl, data.email);
        return true;
      case MESSAGE_TYPES.CHECK_JIRA_CONNECTION:
        await this.handleCheckConnection();
        return true;
      default:
        return false;
    }
  }

  private async handleSaveCredentials(siteUrl: string, email: string, apiToken: string): Promise<void> {
    try {
      const identity = await this.jiraAuthService.connectWithApiToken(siteUrl, email, apiToken);
      this.analyticsService.trackEvent('jira_connected');
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_CREDENTIALS_SUCCESS,
        accountId: identity.accountId,
        displayName: identity.displayName,
      });
      await this.handleFetchProjects(siteUrl, email);
    } catch (error) {
      console.error('Error saving Jira credentials:', error);
      this.analyticsService.trackEvent('jira_connect_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_CREDENTIALS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleDisconnect(): Promise<void> {
    try {
      await this.jiraAuthService.disconnect();

      const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
      if (settings?.state?.config?.jira) {
        settings.state.config.jira = {
          ...settings.state.config.jira,
          isAuthenticated: false,
          siteUrl: '',
          email: '',
          projectKey: '',
          projectName: '',
          availableProjects: [],
          accountId: '',
          displayName: '',
        };
        await this.context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
      }

      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.DISCONNECT_JIRA,
        success: true,
      });
    } catch (error) {
      console.error('Error disconnecting Jira:', error);
    }
  }

  /**
   * Lists projects so the settings panel can offer a dropdown instead of a
   * typed key. Called both on explicit request and automatically right after
   * a successful connect — a soft failure here (e.g. a token that can't read
   * project/search) just leaves the dropdown empty and falls back to manual
   * entry, never blocks connecting. Mirrors AdoMessageHandler's
   * handleFetchAdoOrganizations for the same reason.
   */
  private async handleFetchProjects(siteUrl: string, email: string): Promise<void> {
    try {
      if (!siteUrl || !email) {
        throw new Error('Jira site URL and email are required to fetch projects.');
      }
      const projects = await this.jiraAuthService.fetchProjects(siteUrl, email);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS_SUCCESS,
        projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name })),
      });
    } catch (error) {
      console.error('Error fetching Jira projects:', error);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.FETCH_JIRA_PROJECTS_ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleCheckConnection(): Promise<void> {
    try {
      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const siteUrl = settings?.state?.config?.jira?.siteUrl;
      const email = settings?.state?.config?.jira?.email;
      if (!siteUrl || !email) {
        throw new Error('Jira configuration is incomplete. Please connect.');
      }
      const identity = await this.jiraAuthService.checkConnection(siteUrl, email);
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_CONNECTION_STATUS,
        status: true,
        message: `Successfully connected to Jira as ${identity.displayName}.`,
      });
    } catch (error) {
      this.analyticsService.trackEvent('jira_connection_error', {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.webviewView.webview.postMessage({
        type: MESSAGE_TYPES.JIRA_CONNECTION_STATUS,
        status: false,
        message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}
