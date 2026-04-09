import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

type IDEType = 'cursor' | 'vscode';

interface IDEConfig {
  type: IDEType;
  label: string;
  /** The root key inside mcp.json — VS Code uses "servers", Cursor uses "mcpServers" */
  serversKey: string;
  /** Resolved absolute path to the mcp.json file */
  mcpJsonPath: string;
}

/**
 * Detects the current IDE and returns its MCP configuration details.
 */
function detectIDE(): IDEConfig {
  const appName = vscode.env.appName || '';
  const isCursor = appName.toLowerCase().includes('cursor');

  if (isCursor) {
    // Cursor: global config at ~/.cursor/mcp.json
    return {
      type: 'cursor',
      label: 'Cursor',
      serversKey: 'mcpServers',
      mcpJsonPath: path.join(os.homedir(), '.cursor', 'mcp.json'),
    };
  }

  // VS Code: workspace-local .vscode/mcp.json
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootPath = workspaceFolders?.[0]?.uri.fsPath ?? '';
  return {
    type: 'vscode',
    label: 'VS Code',
    serversKey: 'servers',
    mcpJsonPath: path.join(rootPath, '.vscode', 'mcp.json'),
  };
}

/**
 * Installs the WorkspaceGPT MCP server configuration.
 *
 * - VS Code  → writes to `{workspace}/.vscode/mcp.json` using `{ "servers": { ... } }`
 * - Cursor   → writes to `~/.cursor/mcp.json`            using `{ "mcpServers": { ... } }`
 */
export async function installMcpServer(context: vscode.ExtensionContext) {
  const ide = detectIDE();

  // For VS Code we need an open workspace; for Cursor we write to the global home dir.
  if (ide.type === 'vscode') {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage(
        'WorkspaceGPT: You must open a workspace folder to configure the MCP server in VS Code.'
      );
      return;
    }
  }

  const mcpJsonPath = ide.mcpJsonPath;
  const dirPath = path.dirname(mcpJsonPath);

  try {
    // 1. Ensure parent directory exists
    if (!fs.existsSync(dirPath)) {
      await fs.promises.mkdir(dirPath, { recursive: true });
    }

    // 2. Read existing mcp.json or start fresh
    let mcpConfig: Record<string, any> = {};

    if (fs.existsSync(mcpJsonPath)) {
      const fileContent = await fs.promises.readFile(mcpJsonPath, 'utf8');
      try {
        mcpConfig = JSON.parse(fileContent);
      } catch {
        vscode.window.showErrorMessage(
          `WorkspaceGPT: Could not parse ${mcpJsonPath}. Please fix any syntax errors and try again.`
        );
        return;
      }
    }

    // 3. Ensure the servers container object exists
    if (!mcpConfig[ide.serversKey]) {
      mcpConfig[ide.serversKey] = {};
    }

    // 4. Inject the WorkspaceGPT entry
    const serverEntry: Record<string, any> = {
      command: 'node',
      args: [
        context.asAbsolutePath('./dist/mcp-server.js'),
        '--data-dir',
        context.globalStorageUri.fsPath,
      ],
    };

    // VS Code format wraps each server in a "type" field
    if (ide.type === 'vscode') {
      serverEntry.type = 'stdio';
    }

    mcpConfig[ide.serversKey]['workspacegpt'] = serverEntry;

    // 5. Write back
    await fs.promises.writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    // 6. Notify user
    const openAction = 'Open File';
    const relativePath = ide.type === 'cursor' ? '~/.cursor/mcp.json' : '.vscode/mcp.json';
    const result = await vscode.window.showInformationMessage(
      `WorkspaceGPT MCP Server configured for ${ide.label} in ${relativePath}`,
      openAction
    );

    if (result === openAction) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(mcpJsonPath));
      await vscode.window.showTextDocument(document);
    }
  } catch (err) {
    console.error('Failed to install MCP server config:', err);
    vscode.window.showErrorMessage(
      `WorkspaceGPT: Failed to write mcp.json — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
