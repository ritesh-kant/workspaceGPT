# WorkspaceGPT MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes your synced **Confluence**, **Azure DevOps**, and **Jira** knowledge base as searchable tools — usable inside **Cursor**, **Claude Desktop**, **Windsurf**, and any MCP-compatible client.

## How It Works

```
┌────────────────────────────────┐
│  VS Code Extension (existing)  │
│ Sync & Index Confluence/ADO/Jira│
│         ↓                      │
│  Markdown + Embeddings on disk │
└────────────┬───────────────────┘
             │ reads
┌────────────▼───────────────────┐
│     MCP Server (this app)      │
│  Loads embeddings, serves      │
│  search tools via stdio        │
└────────────┬───────────────────┘
             │ MCP protocol
┌────────────▼───────────────────┐
│   Cursor / Claude Desktop /    │
│   Windsurf / Roo Code          │
└────────────────────────────────┘
```

> **Note**: You need to sync your data first using the [WorkspaceGPT VS Code extension](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension). The MCP server is a read-only search layer.

## Prerequisites

1. **Node.js 18+**
2. **WorkspaceGPT VS Code extension** installed and configured with at least one data source synced and indexed

## Quick Start

```bash
# From the monorepo root
cd apps/workspacegpt-mcp

# Install dependencies
pnpm install

# Build
pnpm build

# Test (prints help)
node dist/index.js --help
```

## Available Tools

| Tool | Description |
|------|-------------|
| `search_confluence` | Search Confluence wiki pages, docs, and guides |
| `search_ado` | Search Azure DevOps work items, bugs, stories, and tasks |
| `search_jira` | Search Jira issues, bugs, stories, and tasks |
| `search_workspace` | Search across all connected sources |

Tools are registered conditionally — only sources that have been synced appear.

## Setup

### Cursor

1. Open **Cursor Settings** → **MCP**
2. Add a new server with this config:

```json
{
  "mcpServers": {
    "workspacegpt": {
      "command": "node",
      "args": ["/absolute/path/to/workspaceGPT/apps/workspacegpt-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

1. Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
2. Add:

```json
{
  "mcpServers": {
    "workspacegpt": {
      "command": "node",
      "args": ["/absolute/path/to/workspaceGPT/apps/workspacegpt-mcp/dist/index.js"]
    }
  }
}
```

### Windsurf / Other MCP Clients

Follow your client's MCP server setup docs, using:
- **Command**: `node`
- **Args**: `["/path/to/dist/index.js"]`

## Configuration

The MCP server auto-detects the WorkspaceGPT data directory from your VS Code installation. If auto-detection fails, you can specify it manually:

```bash
# Via CLI argument
node dist/index.js --data-dir ~/Library/Application\ Support/Code/User/globalStorage/riteshkant.workspacegpt-extension

# Via environment variable
WORKSPACEGPT_DATA_DIR=/path/to/data node dist/index.js
```

## Development

```bash
# Watch mode (rebuilds on changes)
pnpm dev

# Test with MCP Inspector
npx @modelcontextprotocol/inspector node dist/index.js
```

## License

See the root [LICENSE](../../LICENSE) file.
