import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Checks if the WorkspaceGPT MCP server is already configured.
 *
 * - VS Code: Looks for `.vscode/mcp.json` with `servers.workspacegpt` entry
 * - Cursor: Looks for `~/.cursor/mcp.json` with `mcpServers.workspacegpt` entry
 */
export async function isMcpInstalled(): Promise<boolean> {
  const appName = vscode.env.appName || '';
  const isCursor = appName.toLowerCase().includes('cursor');

  let mcpJsonPath: string;
  let serversKey: string;

  if (isCursor) {
    // Cursor: global config at ~/.cursor/mcp.json
    mcpJsonPath = path.join(os.homedir(), '.cursor', 'mcp.json');
    serversKey = 'mcpServers';
  } else {
    // VS Code: workspace-local .vscode/mcp.json
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!rootPath) {
      // No workspace folder open, so MCP can't be configured
      return false;
    }
    mcpJsonPath = path.join(rootPath, '.vscode', 'mcp.json');
    serversKey = 'servers';
  }

  try {
    if (!fs.existsSync(mcpJsonPath)) {
      return false;
    }

    const fileContent = await fs.promises.readFile(mcpJsonPath, 'utf8');
    const mcpConfig = JSON.parse(fileContent);

    // Check if workspacegpt entry exists in the correct servers key
    return !!(mcpConfig[serversKey]?.workspacegpt);
  } catch {
    // If file doesn't exist or is malformed, consider it not installed
    return false;
  }
}
