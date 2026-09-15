import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { AnalyticsService } from '../services/analyticsService';
import { ConfluenceMessageHandler } from './ConfluenceMessageHandler';
import { AdoMessageHandler } from './AdoMessageHandler';
import { JiraMessageHandler } from './JiraMessageHandler';
import { ChatMessageHandler } from './ChatMessageHandler';
import { SystemMessageHandler } from './SystemMessageHandler';
import { DeploymentMessageHandler } from './DeploymentMessageHandler';
import { RemoteAuthMessageHandler } from './RemoteAuthMessageHandler';
import { HistoryService } from '../services/historyService';
import { getEmbeddingSettings, EmbeddingSettings } from '../utils/getEmbeddingSettings';
import { getMode } from '../utils/getModeSettings';
import { RemoteSignInService } from '../services/remote/remoteSignInService';

/** Display label for an embedding provider, used in the re-index prompt. */
function providerLabel(provider: 'local' | 'gemini'): string {
  return provider === 'gemini' ? 'Google Gemini (cloud)' : 'Local (on-device)';
}

/**
 * The *usable* embedding provider implied by the current settings. Selecting
 * Gemini without an API key isn't usable yet, so it resolves to null — we only
 * re-index once a real, queryable provider is in effect.
 */
function resolvedEmbeddingProvider(
  settings: EmbeddingSettings
): 'local' | 'gemini' | null {
  if (settings.provider === 'local') return 'local';
  if (settings.provider === 'gemini' && settings.apiKey) return 'gemini';
  return null;
}

export class WebviewMessageHandler {
  private analyticsService: AnalyticsService;
  private historyService: HistoryService;
  
  private confluenceHandler: ConfluenceMessageHandler;
  private adoHandler: AdoMessageHandler;
  private jiraHandler: JiraMessageHandler;
  private chatHandler: ChatMessageHandler;
  private systemHandler: SystemMessageHandler;
  private deploymentHandler: DeploymentMessageHandler;
  private remoteAuthHandler: RemoteAuthMessageHandler;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext
  ) {
    this.analyticsService = new AnalyticsService(context);
    this.historyService = new HistoryService(context);

    // Initialize domain-specific handlers
    this.confluenceHandler = new ConfluenceMessageHandler(webviewView, context, this.analyticsService);
    this.adoHandler = new AdoMessageHandler(webviewView, context, this.analyticsService);
    this.jiraHandler = new JiraMessageHandler(webviewView, context, this.analyticsService);
    this.chatHandler = new ChatMessageHandler(webviewView, context, this.analyticsService, this.historyService);
    this.systemHandler = new SystemMessageHandler(webviewView, context, this.analyticsService);
    this.deploymentHandler = new DeploymentMessageHandler(webviewView, context, this.analyticsService);
    this.remoteAuthHandler = new RemoteAuthMessageHandler(webviewView, context, this.analyticsService);

    // Warm the search workers now (webview is opening) so the first chat query is fast.
    this.chatHandler.prewarm();
  }

  /** Tear down chat search workers. Called on webview dispose. */
  public dispose(): void {
    this.chatHandler.dispose();
    this.deploymentHandler.dispose();
  }

  public async handleMessage(data: any): Promise<void> {
    if (data.type === MESSAGE_TYPES.RESET) {
      await this.reset();
      return;
    }

    // GitHub sign-in gate — remote mode only; local mode stays account-free.
    // The Settings panel's "Sign Up with WorkspaceGPT" button
    // (RemoteAccountSettings.tsx) is the normal path in; this catches a
    // remote-mode user who never signed in and tries to chat anyway.
    //
    // Deliberately a local token-presence check, not a network call: this runs
    // per message, and it is a UX shortcut, not the security boundary. The
    // boundary is the Worker, which re-validates the session on every
    // /v1/chat/completions call and 401s a revoked or expired one (surfaced by
    // describeLlmFailure in modelWorker.ts).
    if (data.type === MESSAGE_TYPES.SEND_MESSAGE && getMode(this.context) === 'remote') {
      const signedIn = await new RemoteSignInService(this.context).isSignedIn();
      if (!signedIn) {
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.ERROR_CHAT,
          message: 'Sign in with WorkspaceGPT under Settings → Account to use remote mode.',
        });
        return;
      }
    }

    // A settings update may switch the embedding provider. Capture the active
    // (usable) provider *before* the new settings are persisted so we can detect
    // the switch afterwards and offer a clean re-index.
    const isSettingsUpdate =
      data.type === MESSAGE_TYPES.UPDATE_GLOBAL_STATE &&
      data.key === STORAGE_KEYS.SETTINGS;
    const providerBefore = isSettingsUpdate
      ? resolvedEmbeddingProvider(getEmbeddingSettings(this.context))
      : null;

    // Delegate message to appropriate handler
    if (await this.remoteAuthHandler.handleMessage(data)) return;
    if (await this.confluenceHandler.handleMessage(data)) return;
    if (await this.adoHandler.handleMessage(data)) return;
    if (await this.jiraHandler.handleMessage(data)) return;
    if (await this.chatHandler.handleMessage(data)) return;
    if (await this.deploymentHandler.handleMessage(data)) return;
    if (await this.systemHandler.handleMessage(data)) {
      if (isSettingsUpdate) {
        const providerAfter = resolvedEmbeddingProvider(
          getEmbeddingSettings(this.context)
        );
        if (providerAfter && providerAfter !== providerBefore) {
          await this.handleEmbeddingProviderChange(providerBefore, providerAfter);
        }
      }
      return;
    }

    console.warn(`Unhandled message type: ${data.type}`);
  }

  /**
   * The embedding provider was switched (e.g. Local ↔ Gemini). Existing indexes
   * were built with the previous provider and produce incompatible vectors, so
   * offer to rebuild every connected source (Confluence + Azure DevOps) from
   * scratch. Re-indexing only re-embeds the already-synced markdown — it does
   * not re-download from the source.
   */
  private async handleEmbeddingProviderChange(
    before: 'local' | 'gemini' | null,
    after: 'local' | 'gemini'
  ): Promise<void> {
    const settings = this.context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
    const confluenceConnected = !!settings?.state?.config?.confluence?.isConnected;
    const adoConnected = !!settings?.state?.config?.ado?.config?.isAdoConnected;

    // Nothing indexed yet — the new provider will simply be used on first sync.
    if (!confluenceConnected && !adoConnected) {
      return;
    }

    const sources = [
      confluenceConnected && 'Confluence',
      adoConnected && 'Azure DevOps',
    ]
      .filter(Boolean)
      .join(' and ');

    const intro = before
      ? `Embedding provider changed from ${providerLabel(before)} to ${providerLabel(after)}.`
      : `Embedding provider set to ${providerLabel(after)}.`;

    const choice = await vscode.window.showInformationMessage(
      `${intro} Your existing ${sources} index was built with a different provider ` +
        `and must be rebuilt to stay searchable. Re-index now?`,
      { modal: true },
      'Re-index now'
    );

    if (choice !== 'Re-index now') {
      return; // User chose "Later" / dismissed — they can re-index manually.
    }

    this.analyticsService.trackEvent('embedding_provider_reindex', {
      from: before ?? 'none',
      to: after,
    });

    try {
      if (confluenceConnected) {
        await this.confluenceHandler.reindexAfterProviderChange();
      }
      if (adoConnected) {
        await this.adoHandler.reindexAfterProviderChange();
      }
      // Stale chat search workers were initialized with the old provider; drop
      // them so the next query re-spawns one using the new provider.
      this.chatHandler.refreshSearchWorkers();
    } catch (error) {
      console.error('Error re-indexing after embedding provider change:', error);
      vscode.window.showErrorMessage(
        `Failed to re-index after switching embedding provider: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async reset() {
    try {
      // Orchestrate reset across all handlers
      await this.confluenceHandler.reset();
      await this.adoHandler.reset();
      await this.systemHandler.reset();
      this.chatHandler.dispose();
      
      console.log('WorkspaceGPT fully reset.');
    } catch (error) {
      console.error('Error during WorkspaceGPT reset:', error);
    }
  }
}
