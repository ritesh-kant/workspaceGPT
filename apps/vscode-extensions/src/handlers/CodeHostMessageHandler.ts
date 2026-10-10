import * as vscode from 'vscode';
import { MESSAGE_TYPES } from '../../constants';
import { CodeHostConnections } from '../services/codehost/connections';
import type { CodeHostKind } from '../services/codehost/types';
import { AnalyticsService } from '../services/analyticsService';

/** Code-host (GitHub / GitLab / Bitbucket) connect / disconnect / status. See services/codehost/connections.ts. */
export class CodeHostMessageHandler {
  private connections: CodeHostConnections;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.connections = new CodeHostConnections(context);
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.CODEHOST_GET_STATUS:
        await this.postStatus();
        return true;
      case MESSAGE_TYPES.CODEHOST_CONNECT_OAUTH:
        this.analyticsService.trackEvent('codehost_connect_started', { kind: 'github', method: 'oauth' });
        await this.connect(() => this.connections.connectGitHubOAuth());
        return true;
      case MESSAGE_TYPES.CODEHOST_CONNECT_GH:
        this.analyticsService.trackEvent('codehost_connect_started', { kind: 'github', method: 'gh-cli' });
        await this.connect(() =>
          this.connections.connectWithGhCli(
            String(data.host ?? ''),
            ({ code, url }) => this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.CODEHOST_GH_CODE, code, url }),
            (url) => void vscode.env.openExternal(vscode.Uri.parse(url))
          )
        );
        return true;
      case MESSAGE_TYPES.CODEHOST_CANCEL_OAUTH:
        this.connections.cancelOAuth();
        await this.postStatus({ error: 'Cancelled.' });
        return true;
      case MESSAGE_TYPES.CODEHOST_CONNECT_TOKEN: {
        const kind = (['github', 'gitlab', 'bitbucket'] as const).includes(data.kind) ? (data.kind as CodeHostKind) : 'github';
        this.analyticsService.trackEvent('codehost_connect_started', { kind, method: 'token' });
        await this.connect(() => this.connections.connectWithToken({ kind, host: String(data.host ?? ''), username: String(data.username ?? ''), token: String(data.token ?? '') }));
        return true;
      }
      case MESSAGE_TYPES.CODEHOST_DISCONNECT:
        this.analyticsService.trackEvent('codehost_connection_removed');
        await this.connections.remove(String(data.id ?? ''));
        await this.postStatus();
        return true;
      default:
        return false;
    }
  }

  private async connect(run: () => Promise<{ warning?: string }>): Promise<void> {
    try {
      const { warning } = await run();
      this.analyticsService.trackEvent('codehost_connected');
      await this.postStatus({ warning });
    } catch (e) {
      await this.postStatus({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Never carries a token — only who is connected and where. */
  private async postStatus(extra: { error?: string; warning?: string } = {}): Promise<void> {
    const connections = await this.connections.summaries();
    // No connection for this workspace's host, but the GitHub CLI is signed in to it: that is used as-is.
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // With no usable folder, github.com through gh is still enough to list the user's own PRs.
    const cliHost = (folder ? (await this.connections.viaGhCli(folder).catch(() => null))?.host : undefined) ?? (await this.connections.defaultGitHub().catch(() => null));
    const detected = cliHost && !connections.some((c) => c.kind === cliHost.kind && c.host === cliHost.host) ? { host: cliHost.host } : undefined;
    this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.CODEHOST_STATUS, connections, detected, ...extra });
  }
}
