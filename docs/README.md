# Docs

User-facing documentation lives on the website: [workspacegpt.in/docs](https://workspacegpt.in/docs).
This folder is for people working on WorkspaceGPT itself.

## Start here

- [architecture.md](architecture.md): how the extension, Desktop, MCP server
  and the two small servers fit together, the agent loop, and the retrieval
  pipeline.
- [north-star.md](north-star.md): what the product is for. Read it before
  proposing a feature.
- [roadmap.md](roadmap.md): the ordered plan (phases, what shipped when).
- [todo.md](todo.md): known follow-ups that aren't scheduled yet.

## Designs (built)

Each of these describes something that is in the tree. The status line at the
top of each says what was built and when.

| Doc | Covers |
|---|---|
| [design/desktop.md](design/desktop.md) | WorkspaceGPT Desktop: Tauri shell, sidecar, `vscode-compat`, packaging, updater. Results in [`apps/desktop/NOTES.md`](../apps/desktop/NOTES.md) |
| [design/remote-mode.md](design/remote-mode.md) | Remote mode on Cloudflare: sign-in, sessions, credits, inference proxy |
| [design/jira.md](design/jira.md) | Jira as a knowledge source (OAuth, sync, tickets, MCP) |
| [design/ticket-entry-point.md](design/ticket-entry-point.md) | Starting work from a ticket: `get_ticket`, "Your work" |
| [design/agent-parity.md](design/agent-parity.md) | Closing the gap with Claude Code on long agent runs |
| [design/exploration-decomposition.md](design/exploration-decomposition.md) | The exploration subagent |
| [design/deployment-automation.md](design/deployment-automation.md) | Config-sync and hotfix releases, plus connection setup (§12) |
| [design/coding-agent-roadmap.md](design/coding-agent-roadmap.md) | The original capability map for becoming a coding agent (sequencing moved to roadmap.md) |

## Proposals (not built)

- [proposals/skills.md](proposals/skills.md): deterministic skill recipes for
  smaller models.

## Elsewhere

- Each app and package has its own README where there's something to say, for
  example [`apps/workspacegpt-mcp`](../apps/workspacegpt-mcp/README.md),
  [`packages/agent-evals`](../packages/agent-evals/README.md) and
  [`apps/vscode-extensions/scripts`](../apps/vscode-extensions/scripts/README.md).
- [`AGENTS.md`](../AGENTS.md): conventions for contributors and coding agents.
