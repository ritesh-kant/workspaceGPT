import * as vscode from 'vscode';
import { WebViewProvider } from './webViewprovider';
import { EXTENSION, MESSAGE_TYPES } from '../constants';
import { AnalyticsService } from './services/analyticsService';
import { ConfluenceSyncScheduler } from './services/confluence/confluenceSyncScheduler';
import { AdoSyncScheduler } from './services/ado/adoSyncScheduler';
import { McpUiManager } from './utils/mcpUiManager';
import { syncContextKeys } from './utils/syncContextKeys';
import { migrateModeSettings } from './utils/migrateModeSettings';
import { UpdateChecker } from './utils/updateChecker';

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
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );
    }
  );

  // Register the new chat command
  let newChatDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_NEW_CHAT,
    () => {
      analyticsService.trackEvent('command_new_chat_triggered');
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      // Get the webview view and send a message to create a new chat
      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.NEW_CHAT });
      }
    }
  );

  // Register the settings command
  let settingsDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_SETTINGS,
    () => {
      analyticsService.trackEvent('command_settings_triggered');
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      // Get the webview view and send a message to show settings
      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.SHOW_SETTINGS });
      }
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
      // Focus on the chat view when command is triggered
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      // Get the webview view and send a message to show history
      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.SHOW_HISTORY });
      }
    }
  );
  context.subscriptions.push(historyDisposable);

  // Register the releases command
  let releasesDisposable = vscode.commands.registerCommand(
    EXTENSION.COMMAND_RELEASES,
    () => {
      analyticsService.trackEvent('command_releases_triggered');
      vscode.commands.executeCommand(
        `workbench.view.extension.${EXTENSION.VIEW_CONTAINER}`
      );

      const webviewView = webViewProvider.getWebviewView();
      if (webviewView) {
        webviewView.webview.postMessage({ type: MESSAGE_TYPES.SHOW_RELEASES });
      }
    }
  );
  context.subscriptions.push(releasesDisposable);

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
