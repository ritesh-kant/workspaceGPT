# WorkspaceGPT vs Claude Code + MCP

Draft positioning, written 2026-11-04. Internal: check every row against the
current product and the current Atlassian / Azure DevOps MCP servers before it
goes on the website.

## The one-liner

Claude Code is a general agent with connectors. WorkspaceGPT is an agent whose
memory is your organisation's Knowledge. We don't compete on the model.

People say "Claude can already read Confluence through MCP". That is true, so
don't argue it. The difference is what happens after it can reach the pages.

## Comparison

| | Claude Code + MCP servers | WorkspaceGPT |
|---|---|---|
| How Knowledge is read | Live fetch: one search call per query, through the source's own search API | Synced into an on-device index with embeddings; semantic search across all Knowledge |
| If the model picks the wrong keyword | The right page is never seen | Retrieval doesn't depend on the model guessing the page's wording |
| Where indexing happens | Nothing is indexed; every page the agent browses goes to the model provider | Indexing and embeddings stay on-device; only retrieved snippets for a turn leave the machine |
| Working from a ticket | You describe the process in a prompt or CLAUDE.md | Built in: detect the ticket, research every source, write the spike, ask "Needs your input", list references, publish to Confluence with a review step |
| Where a claim came from | No record of which page backed which statement | Reference index links ids to what the run actually read; reports list their sources |
| Stale Knowledge | No local copy, so nothing to go stale, and nothing to reason over | Incremental sync removes pages deleted, moved or renamed upstream |
| Model choice | Anthropic models | Copilot, OpenRouter, OpenAI, Gemini or managed inference: the model your org already approved |
| Setup | Configure each MCP server, tokens, CLAUDE.md | One "Connect" per Knowledge source |
| Where it runs | Terminal, desktop, IDE | VS Code, Desktop, and an MCP server so other agents can use the same Knowledge |

## Points to lead with, strongest first

1. **A local index, not a live fetch.** It already knows your org before you
   ask.
2. **Privacy is architecture.** Indexing and embeddings never leave the
   machine, in either mode.
3. **Grounded work, not just access.** Tickets, spikes, references and a
   reviewed publish step are the product. The agent is shaped to stop
   confident claims nobody sourced.
4. **Provenance.** Every reference is something the run actually read.
5. **Any model.** Use the one your security team has already cleared.
6. **No setup.** Connect a Knowledge source and ask.

## Say it as complementary

`apps/workspacegpt-mcp` exposes the same Knowledge to other agents, Claude Code
included. "Use WorkspaceGPT's Knowledge inside Claude Code" lands better than
"instead of Claude Code", and it is accurate.

## Claims to verify before publishing

- The Claude Code side comes from general knowledge of MCP and may be out of
  date. Re-check what the Atlassian and ADO MCP servers can search and write.
- Don't lead with a feature that has not been run live. As of the last notes
  this includes the spike flow, Confluence writes and remembered choices.
- "Only retrieved snippets leave the machine" holds for Remote and Local mode
  as designed. Confirm it against `docs/architecture.md` before quoting it.
- Copy rule: say "Knowledge" and name each source. Never "integrations" or
  "plugins".
