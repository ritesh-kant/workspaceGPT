import * as vscode from 'vscode';
import { isMcpInstalled } from './mcpStatusChecker';

const MCP_WELCOME_SHOWN_KEY = 'workspacegpt.mcp_welcome_shown';

/**
 * Manages the MCP UI elements (welcome notification and status bar button).
 * Shows a welcome notification on first activation if MCP is not yet installed,
 * and maintains a status bar button showing the current MCP connection status.
 */
export class McpUiManager {
  private statusBarItem: vscode.StatusBarItem;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90 // Position: just left of the language mode indicator
    );
  }

  /**
   * Initialize the MCP UI: show welcome notification and create status bar button.
   * Should be called once during extension activation.
   */
  async initialize(): Promise<void> {
    // Show welcome notification if not yet shown
    await this.showWelcomeNotificationIfNeeded();

    // Create and show the status bar button
    await this.updateStatusBar();
  }

  /**
   * Updates the status bar button to reflect current MCP installation status.
   */
  async updateStatusBar(): Promise<void> {
    const isInstalled = await isMcpInstalled();

    if (isInstalled) {
      this.statusBarItem.text = '$(check) MCP';
      this.statusBarItem.tooltip = 'WorkspaceGPT MCP Server is connected. Click to configure.';
      this.statusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
    } else {
      this.statusBarItem.text = '$(plug) MCP';
      this.statusBarItem.tooltip = 'WorkspaceGPT: Click to connect MCP Server (Cursor / Copilot / Claude)';
      this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    }

    this.statusBarItem.command = 'workspacegpt.setupMcp';
    this.statusBarItem.show();
  }

  /**
   * Shows a welcome notification about MCP setup, but only once per version.
   * Uses globalState to track if the notification has been shown.
   */
  private async showWelcomeNotificationIfNeeded(): Promise<void> {
    const alreadyShown = this.context.globalState.get(MCP_WELCOME_SHOWN_KEY);

    if (alreadyShown) {
      return; // Already shown in this version
    }

    const isInstalled = await isMcpInstalled();
    if (isInstalled) {
      // Already configured, no need to show welcome
      this.context.globalState.update(MCP_WELCOME_SHOWN_KEY, true);
      return;
    }

    // Show the welcome notification
    const learnMoreAction = 'Learn More';
    const connectAction = 'Connect MCP';
    const dismissAction = 'Dismiss';

    const selection = await vscode.window.showInformationMessage(
      '🚀 WorkspaceGPT MCP Server\n\nUse WorkspaceGPT with Cursor, GitHub Copilot, Claude Desktop, and other AI IDEs! Connect your knowledge base to your favorite AI assistant.',
      { modal: false },
      learnMoreAction,
      connectAction,
      dismissAction
    );

    // Mark as shown (regardless of user action)
    await this.context.globalState.update(MCP_WELCOME_SHOWN_KEY, true);

    if (selection === learnMoreAction) {
      // Open the README or documentation
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse('https://github.com/yourusername/workspacegpt#mcp-integration')
      );
    } else if (selection === connectAction) {
      // Trigger the setup command
      vscode.commands.executeCommand('workspacegpt.setupMcp');
    }
    // If dismissed, do nothing
  }

  /**
   * Disposes of the status bar item (call on extension deactivation).
   */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
