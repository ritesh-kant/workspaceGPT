import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { SessionsViewProvider } from './sessionsViewProvider';
import { HistoryService } from './services/historyService';
import { registerAgentHunkLenses } from './services/agent/agentHunkLens';
import { EXTENSION, MESSAGE_TYPES } from '../constants';
import { AnalyticsService } from './services/analyticsService';
import { ConfluenceSyncScheduler } from './services/confluence/confluenceSyncScheduler';
import { AdoSyncScheduler } from './services/ado/adoSyncScheduler';
import { McpUiManager } from './utils/mcpUiManager';
import { syncContextKeys } from './utils/syncContextKeys';
import { migrateModeSettings } from './utils/migrateModeSettings';
import { UpdateChecker } from './utils/updateChecker';
import { RemoteSignInService, describeRemoteAuthError, webviewFieldsFromProfile } from './services/remote/remoteSignInService';

let analyticsService: AnalyticsService;
let syncScheduler: ConfluenceSyncScheduler;
let adoSyncScheduler: AdoSyncScheduler;
let mcpUiManager: McpUiManager;
let updateChecker: UpdateChecker;

export async function activate(context: vscode.ExtensionContext) {
  // Initialize analytics service
  analyticsService = new AnalyticsService(context);
  analyticsService.trackEvent('extension_activated');
  analyticsService.startSession();

  // Initialize and start background sync scheduler
  syncScheduler = new ConfluenceSyncScheduler(context);
  syncScheduler.start();

  // Initialize and start ADO sync scheduler
  adoSyncScheduler = new AdoSyncScheduler(context);
  adoSyncScheduler.start();

  // Load the remote-mode session token into its sync cache before any webview
  // can request a completion — remote-mode inference uses it as the bearer for
  // the managed endpoint (see remoteSessionCache.ts).
  await RemoteSignInService.primeCache(context);

  // One-time upgrade: stamp `mode` onto pre-existing settings blobs so
  // upgrading installs infer local/remote from their current config instead
  // of being sent through onboarding.
  await migrateModeSettings(context);

  // Reflect persisted toggles into `when`-clause context keys so title-bar
  // icons (Releases, Share to Chrome) hide themselves declaratively.
  await syncContextKeys(context);

  // Search workers are warmed by the chat webview itself (WebviewMessageHandler → ChatService.prewarm),
  // so the warmup lands on the exact service instances the chat queries.

  // Initialize MCP UI Manager (welcome notification + status bar button).
  // Not awaited: the welcome notification resolves only when the user dismisses
  // it, which would block activation (and inflate activation time) on first run.
  mcpUiManager = new McpUiManager(context);
  void mcpUiManager.initialize();

  // Notify the user when a newer WorkspaceGPT release is available. Mainly
  // for manual `.vsix` installs (never auto-updated) and installs with
  // auto-update disabled — see UpdateChecker for details.
  updateChecker = new UpdateChecker(context);
  updateChecker.start();

  // Register WebViewProvider
  const webViewProvider = new WebViewProvider(context.extensionUri, context);
  const sessionsViewProvider = new SessionsViewProvider(
    context.extensionUri,
    new HistoryService(context),
    () => {
      void vscode.commands.executeCommand(EXTENSION.COMMAND_NEW_CHAT);
    },
    (sessionId) => {
      webViewProvider.loadSession(sessionId);
    }
  );
  webViewProvider.setSessionsView(sessionsViewProvider);
  await vscode.commands.executeCommand('setContext', EXTENSION.CONTEXT_CHAT_IN_EDITOR, false);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EXTENSION.VIEW_TYPE,
      webViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      EXTENSION.SESSIONS_VIEW_TYPE,
      sessionsViewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Inline keep/revert lenses on files the agent changed this session.
  registerAgentHunkLenses(context);

  // Register MCP Server for GitHub Copilot / Claude Code discovery (@mcp)
  if (vscode.lm?.registerMcpServerDefinitionProvider) {
    context.subscriptions.push(
      vscode.lm.registerMcpServerDefinitionProvider('workspacegpt.mcpServer', {
        provideMcpServerDefinitions: async () => {
          return [
            new vscode.McpStdioServerDefinition(
              'WorkspaceGPT',
              'node',
              [
                context.asAbsolutePath('./dist/mcp-server.js'),
                '--data-dir',
                context.globalStorageUri.fsPath
              ]
            )
          ];
        }
      })
    );
  }

  // Register the ask command
  let askDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_ASK,
    () => {
      analyticsService.trackEvent('command_ask_triggered');
      webViewProvider.revealChat();
    }
  );

  // Register the new chat command
  let newChatDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_NEW_CHAT,
    () => {
      analyticsService.trackEvent('command_new_chat_triggered');
      webViewProvider.revealChat();
      void webViewProvider.postMessage({ type: MESSAGE_TYPES.NEW_CHAT });
    }
  );

  // Register the settings command
  let settingsDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_SETTINGS,
    () => {
      analyticsService.trackEvent('command_settings_triggered');
      webViewProvider.revealChat();
      void webViewProvider.postMessage({ type: MESSAGE_TYPES.SHOW_SETTINGS });
    }
  );

  context.subscriptions.push(askDisposable);
  context.subscriptions.push(newChatDisposable);
  context.subscriptions.push(settingsDisposable);

  // Register the history command
  let historyDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_HISTORY,
    () => {
      analyticsService.trackEvent('command_history_triggered');
      webViewProvider.revealChat();
      void webViewProvider.postMessage({ type: MESSAGE_TYPES.SHOW_HISTORY });
    }
  );
  context.subscriptions.push(historyDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand(EXTENSION.COMMAND_REFRESH_SESSIONS, () => {
      void sessionsViewProvider.refresh();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(EXTENSION.COMMAND_SEARCH_SESSIONS, () => {
      sessionsViewProvider.toggleSearch();
    })
  );

  // Register the releases command
  let releasesDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_RELEASES,
    () => {
      analyticsService.trackEvent('command_releases_triggered');
      webViewProvider.revealChat();
      void webViewProvider.postMessage({ type: MESSAGE_TYPES.SHOW_RELEASES });
    }
  );
  context.subscriptions.push(releasesDisposable);

  let openChatInEditorDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_OPEN_CHAT_IN_EDITOR,
    async () => {
      analyticsService.trackEvent('command_open_chat_in_editor_triggered');
      await webViewProvider.openChatInEditor();
    }
  );
  context.subscriptions.push(openChatInEditorDisposable);

  let restoreChatDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_RESTORE_CHAT_TO_SIDEBAR,
    async () => {
      analyticsService.trackEvent('command_restore_chat_to_sidebar_triggered');
      await webViewProvider.restoreChatToSidebar();
    }
  );
  context.subscriptions.push(restoreChatDisposable);

  // Revert the workspace to an agent checkpoint (shadow-git snapshots taken
  // before every approved agent write).
  let revertCheckpointDisposable = vscode.commands.registerCommand(
    'workspacegpt.revertAgentCheckpoint',
    async () => {
      analyticsService.trackEvent('command_revert_agent_checkpoint_triggered');
      const root = vscode.workspace.workspaceFolders?.[0];
      if (!root) {
        vscode.window.showWarningMessage('WorkspaceGPT: open a workspace folder first.');
        return;
      }
      const { checkpointServiceFor } = await import('./services/agent/checkpointService');
      const service = checkpointServiceFor(context.globalStorageUri.fsPath, root.uri.fsPath);
      const checkpoints = await service.list(30);
      if (!checkpoints.length) {
        vscode.window.showInformationMessage('WorkspaceGPT: no agent checkpoints yet — they are created when you approve agent edits.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        checkpoints.map((c) => ({
          label: c.label,
          description: new Date(c.timestamp).toLocaleString(),
          detail: c.sha.slice(0, 10),
          sha: c.sha,
        })),
        { placeHolder: 'Restore the workspace to the state saved at…' }
      );
      if (!picked) return;
      const confirm = await vscode.window.showWarningMessage(
        `Revert all agent-touched files to "${picked.label}"? Files you changed yourself since then (and never checkpointed) are left alone.`,
        { modal: true },
        'Revert'
      );
      if (confirm !== 'Revert') return;
      await service.revertTo(picked.sha);
      vscode.window.showInformationMessage(`WorkspaceGPT: workspace restored to "${picked.label}".`);
    }
  );
  context.subscriptions.push(revertCheckpointDisposable);

  // Register the clear data command
  let clearDataDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_CLEAR_DATA,
    async () => {
      analyticsService.trackEvent('command_clear_data_triggered');
      const selection = await vscode.window.showWarningMessage(
        "Are you sure you want to clear all WorkspaceGPT data and cache? This cannot be undone.",
        { modal: true },
        "Yes, Clear Data"
      );

      if (selection === "Yes, Clear Data") {
        // Stop any active background schedulers
        if (syncScheduler) {
          syncScheduler.stop();
        }
        if (adoSyncScheduler) {
          adoSyncScheduler.stop();
        }
        
        // If webview is active, tell it to reset (handles explicit stop of embedding process and auth disconnection)
        const webviewView = webViewProvider.getWebviewView();
        if (webviewView) {
          await webViewProvider.sendMessage({ type: MESSAGE_TYPES.RESET });
        } else {
          // If webview is not active, clear directories and global state manually
          const { clearWorkspaceGPTData } = await import('./utils/clearData');
          await clearWorkspaceGPTData(context);
        }
        
        vscode.window.showInformationMessage("WorkspaceGPT: All data and cache cleared successfully.");
      }
    }
  );
  context.subscriptions.push(clearDataDisposable);

  // Register MCP Setup command
  let setupMcpDisposable = vscode.commands.registerCommand(
    'workspacegpt.setupMcp',
    async () => {
      analyticsService.trackEvent('command_setup_mcp_triggered');
      const { installMcpServer } = await import('./utils/mcpInstaller');
      await installMcpServer(context);
      // Update status bar after installation
      if (mcpUiManager) {
        await mcpUiManager.updateStatusBar();
      }
    }
  );
  context.subscriptions.push(setupMcpDisposable);

  // Register Share-to-Chrome command
  let shareDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_SHARE_TO_CHROME,
    async () => {
      analyticsService.trackEvent('command_share_to_chrome_triggered');
      const { shareToChrome } = await import('./utils/shareToChrome');
      await shareToChrome(context);
    }
  );
  context.subscriptions.push(shareDisposable);

  // Remote-mode sign-in/sign-out commands — a Command Palette alternative to
  // the "Sign Up with WorkspaceGPT" button in Settings → Account
  // (RemoteAccountSettings.tsx / RemoteAuthMessageHandler.ts).
  let signInRemoteDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_SIGN_IN_REMOTE,
    async () => {
      analyticsService.trackEvent('command_sign_in_remote_triggered');
      const service = new RemoteSignInService(context);
      try {
        await service.signIn();
        const result = await service.verifySession();
        const profile = result.state === 'signed_in' ? result.profile : null;
        webViewProvider.postMessage({
          type: MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS,
          ...webviewFieldsFromProfile(profile),
        });
        vscode.window.showInformationMessage(
          profile
            ? `WorkspaceGPT: signed in as ${profile.github_login}.`
            : 'WorkspaceGPT: signed in (session stored, but /v1/me did not confirm it).'
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `WorkspaceGPT: sign-in failed — ${describeRemoteAuthError(error)}`
        );
      }
    }
  );
  context.subscriptions.push(signInRemoteDisposable);

  let signOutRemoteDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_SIGN_OUT_REMOTE,
    async () => {
      analyticsService.trackEvent('command_sign_out_remote_triggered');
      const service = new RemoteSignInService(context);
      if (!(await service.isSignedIn())) {
        vscode.window.showInformationMessage('WorkspaceGPT: not signed in.');
        return;
      }
      await service.signOut();
      webViewProvider.postMessage({
        type: MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS,
      });
      vscode.window.showInformationMessage('WorkspaceGPT: signed out.');
    }
  );
  context.subscriptions.push(signOutRemoteDisposable);
}

export async function deactivate() {
  // Dispose MCP UI Manager
  if (mcpUiManager) {
    mcpUiManager.dispose();
  }

  updateChecker?.stop();

  // Stop background scheduler
  if (syncScheduler) {
    syncScheduler.stop();
  }

  if (adoSyncScheduler) {
    adoSyncScheduler.stop();
  }

  // Chat search workers are owned by the webview and disposed on its onDidDispose.

  // Close out the session (emits a precise session_ended duration) and flush
  // before deactivating.
  analyticsService?.endSession();
  await analyticsService?.flush();
}
