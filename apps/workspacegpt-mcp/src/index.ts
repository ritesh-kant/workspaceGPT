/**
 * WorkspaceGPT MCP Server
 *
 * Exposes Confluence, Azure DevOps & Jira search as MCP tools,
 * making WorkspaceGPT's knowledge base available inside
 * Cursor, Claude Desktop, Windsurf, and other MCP clients.
 *
 * Usage:
 *   node dist/index.js [--data-dir /path/to/data]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveDataDir, getAvailableSources } from './utils/dataDir.js';
import { SearchEngine } from './search/searchEngine.js';
import { createSearchConfluenceTool, createSearchAdoTool, createSearchJiraTool, createSearchWorkspaceTool } from './tools/searchTools.js';

async function main() {
  // Show help
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
WorkspaceGPT MCP Server

Exposes your synced Confluence, Azure DevOps & Jira knowledge base as MCP tools.

Usage:
  workspacegpt-mcp [options]

Options:
  --data-dir <path>   Path to the WorkspaceGPT data directory
                      (auto-detected from VS Code globalStorage by default)
  --help, -h          Show this help message

Environment Variables:
  WORKSPACEGPT_DATA_DIR   Alternative way to specify the data directory

Setup:
  1. Sync your Confluence/ADO/Jira data using the WorkspaceGPT VS Code extension
  2. Add this server to your MCP client config:

     Cursor (Settings → MCP):
       {
         "mcpServers": {
           "workspacegpt": {
             "command": "node",
             "args": ["${process.argv[1]}"]
           }
         }
       }

     Claude Desktop (claude_desktop_config.json):
       {
         "mcpServers": {
           "workspacegpt": {
             "command": "node",
             "args": ["${process.argv[1]}"]
           }
         }
       }
`);
    process.exit(0);
  }

  // ── Resolve Data Directory ──────────────────────────────────────────

  let dataDir: string;
  try {
    dataDir = resolveDataDir(process.argv.slice(2));
  } catch (err) {
    console.error(`[WorkspaceGPT MCP] Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.error(`[WorkspaceGPT MCP] Data directory: ${dataDir}`);

  const available = getAvailableSources(dataDir);
  console.error(`[WorkspaceGPT MCP] Available sources: ${JSON.stringify(available)}`);

  if (!available.confluence && !available.ado && !available.jira) {
    console.error(
      '[WorkspaceGPT MCP] Warning: No embedding data found. ' +
      'Please sync and index your data from the WorkspaceGPT VS Code extension.'
    );
  }

  // ── Initialize Search Engine ────────────────────────────────────────

  const engine = new SearchEngine(dataDir);
  await engine.initialize();

  const stats = engine.getStats();
  console.error(`[WorkspaceGPT MCP] Embedding stats: ${JSON.stringify(stats)}`);

  // ── Create MCP Server ───────────────────────────────────────────────

  const server = new McpServer({
    name: 'workspacegpt',
    version: '1.0.0',
    description:
      'Search your workspace knowledge base — Confluence docs, Azure DevOps and Jira work items, and more.',
  });

  // ── Register Tools ──────────────────────────────────────────────────

  if (available.confluence) {
    const tool = createSearchConfluenceTool(engine);
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
    console.error('[WorkspaceGPT MCP] Registered tool: search_confluence');
  }

  if (available.ado) {
    const tool = createSearchAdoTool(engine);
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
    console.error('[WorkspaceGPT MCP] Registered tool: search_ado');
  }

  if (available.jira) {
    const tool = createSearchJiraTool(engine);
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
    console.error('[WorkspaceGPT MCP] Registered tool: search_jira');
  }

  // Always register the unified search if any source is available
  if (available.confluence || available.ado || available.jira) {
    const tool = createSearchWorkspaceTool(engine);
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
    console.error('[WorkspaceGPT MCP] Registered tool: search_workspace');
  }

  // ── Connect via stdio ───────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[WorkspaceGPT MCP] Server running on stdio. Waiting for MCP client...');
}

main().catch((err) => {
  console.error('[WorkspaceGPT MCP] Fatal error:', err);
  process.exit(1);
});
