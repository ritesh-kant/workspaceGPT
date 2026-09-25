# WorkspaceGPT — Architecture

WorkspaceGPT is a coding agent grounded in an organisation's own knowledge:
Confluence pages, Jira issues and Azure DevOps work items. One codebase, the
VS Code extension in `apps/vscode-extensions`, is the product. It runs in two
hosts:

- **VS Code and its forks** (Cursor, Antigravity, Windsurf, VSCodium), from the
  VS Code Marketplace or Open VSX.
- **WorkspaceGPT Desktop** (`apps/desktop`), a Tauri app that runs the same
  extension, unmodified, outside any editor.

Everything a user connects is synced and indexed **on their machine**. The
only servers are small: an OAuth token exchange, and, for Remote mode, an
inference proxy that stores nothing.

```
                ┌──────────────── user's machine ─────────────────┐
 VS Code ──────►│ extension host ── handlers ── services ── workers│
 or Desktop     │      │                                   │       │
 (Tauri shell)  │   webview (React)            local index (files) │
                └──────┬───────────────────────────┬───────────────┘
                       │ OAuth code exchange        │ Remote mode only:
                       ▼                            ▼ question + retrieved snippets
        apps/confluence-auth-proxy        apps/workspacegpt-api (Cloudflare Worker)
        (Vercel: Atlassian, GitHub,        GitHub sign-in, sessions, credits
         Vercel client secrets)            ──► OpenRouter (zero retention)
```

## Repository map

| Path | What it is |
|---|---|
| `apps/vscode-extensions` | The product: extension host (`src/`), React webview (`webview/`), worker threads (`src/workers/`) |
| `apps/desktop` | WorkspaceGPT Desktop: Rust/Tauri shell (`src-tauri/`), Node sidecar (`sidecar/`), view bridge (`bridge/`), packaging scripts |
| `apps/workspacegpt-mcp` | MCP server exposing `search_confluence`, `search_ado`, `search_jira`, `search_workspace` over the local index |
| `apps/workspacegpt-api` | Cloudflare Worker for Remote mode: GitHub sign-in, KV sessions, D1 accounts, weekly token-metered credits, OpenAI-compatible proxy to OpenRouter |
| `apps/confluence-auth-proxy` | Vercel functions holding OAuth client secrets: Atlassian (Confluence and Jira), GitHub, Vercel |
| `apps/workspacegpt-webapp` | Next.js site and docs at workspacegpt.in |
| `apps/chrome-extension` | Browser side panel, **parked** (see its README) |
| `apps/confluence-extractor`, `apps/confluence-rag` | The original 2025 Node extractor + Python/Streamlit RAG. Legacy, not part of the product |
| `packages/confluence-utils` | Confluence REST client and HTML → Markdown |
| `packages/embedding-core` | Embedding profiles, providers and vector-store code shared by the extension and the Chrome app |
| `packages/release-core` | Config-sync and hotfix planning for deployment automation |
| `packages/agent-evals` | Headless agent eval harness and unit tests (`pnpm units`, `agent-smoke.mjs`) |
| `packages/eslint-config`, `packages/typescript-config` | Shared configs |

## The extension

**Host (`src/`).** `extension.ts` registers services, sync schedulers and
commands. Webview messages route through `handlers/WebviewMessageHandler.ts` to
one handler per area (`Chat`, `Confluence`, `Jira`, `Ado`, `Tickets`,
`Deployment`, `RemoteAuth`, `System`), which call services
(`services/confluence`, `services/jira`, `services/ado`, `services/agent`,
`services/remote`, …). Heavy work runs in worker threads: one per source for sync
and embedding, and `workers/model/modelWorker.ts` for the agent. Credentials live
in the host's secret storage (VS Code `context.secrets`; the macOS Keychain or
Windows Credential Manager on Desktop). Settings and history live in the host's storage.

**Webview (`webview/`).** React + Zustand (`chatStore`, `settingsStore`,
`modelStore`, `uiStore`), built with Vite. The same bundle renders inside VS Code
and inside Desktop. Desktop-only layout is gated on `isDesktopHost()`.

### The agent loop

`modelWorker.ts` runs a tool-calling loop against the selected model. Its tools:

- **Code:** `search_codebase` (ripgrep), `find_files`, `list_directory`,
  `read_file`, `find_symbol`, `go_to_definition`, `find_references`,
  `get_diagnostics` (language server), `explore` / `explore_codebase` (an
  exploration subagent, `explorationPhase.ts` + `exploreSubagent.ts`).
- **Edits:** `create_file`, `edit_file`, `delete_file`. Every write is shown as
  a diff for approval. `CheckpointService` snapshots the workspace before the
  first write, so a whole turn can be reverted.
- **Running things:** `run_command`, `run_checks`. `AutoVerifyTracker`
  (`autoVerify.ts`) runs lint, type-check and tests after edits and feeds the
  results back to the model before it reports.
- **Git:** `git_status`, `git_diff`, `git_log`, `git_blame`.
- **Knowledge:** `search_docs`, `get_confluence_page`, `search_tickets`,
  `get_ticket` (live read of an ADO work item or Jira issue), `search_web`.

Workspace rules are read from `.workspacegpt/rules.md`, `CLAUDE.md`,
`.cursorrules`, `AGENTS.md` and `.github/copilot-instructions.md`
(`services/agent/rulesFiles.ts`). Chats are multi-session. Each session runs
independently, in the sidebar or a full editor tab.

### Knowledge: sync, index, retrieve

1. **Sync.** Confluence and Jira connect via Atlassian OAuth 3LO; the token
   exchange goes through `confluence-auth-proxy`, and tokens stay on the
   machine. Azure DevOps uses an organisation URL + PAT. Sync schedulers
   refresh in the background.
2. **Index.** Pages, issues and work items are embedded on-device with
   `Xenova/all-MiniLM-L6-v2` (384-dim, ONNX via `@xenova/transformers`). The
   vectors are written to local files. There is no cloud embedding provider and
   no hosted vector store. Source code is **not** indexed; the agent reads it
   live with the tools above.
3. **Retrieve** (`services/chatService.ts`), in five stages:
   - **Classify** (`utils/queryClassifier.ts`): a rule ladder picks an intent
     (`chitchat`, `lookup` for ADO ids and Jira keys like `ENG-123`,
     `aggregation`, `comparison`, `semantic`) and routes to the sources that
     can answer it. A low-confidence result may be upgraded by one LLM call, run
     concurrently with the first search.
   - **Plan** (`utils/queryPlanner.ts`): per-intent `topK`, pass count and
     score thresholds (`RETRIEVAL_THRESHOLDS` in `constants.ts`).
   - **Search:** vector search per source. Semantic queries whose best hit
     scores low get a second pass with expanded terms.
   - **Rerank** (`utils/reranker.ts`): dedupe by source file, blend cosine
     (0.65) with a BM25-style term score (0.35), drop hits under the intent's
     threshold.
   - **Answer**, citing the pages and tickets used. Chitchat skips retrieval.

### Modes

- **Local:** the user's own model: Ollama (offline) or a provider key (OpenAI,
  Claude, Gemini, Groq, OpenRouter, NVIDIA, Requesty, or any OpenAI-compatible
  endpoint).
- **Remote:** WorkspaceGPT's managed model through `apps/workspacegpt-api`.
  Sign-in is with GitHub, and every request is re-validated against the
  session. Usage is metered in weekly credits (one credit ≈ 1,000 tokens).
  Only the question and the snippets retrieved for it leave the machine; the
  Worker keeps nothing. Design: [design/remote-mode.md](design/remote-mode.md).

The mode moves inference only. Indexing is local in both.

## WorkspaceGPT Desktop

```
Tauri shell (Rust)  ──spawn──►  Node sidecar (bundled Node 24)
  window, menu, updater,          runs the extension's host code; the `vscode`
  notifications, single-instance  module is apps/desktop/sidecar/vscode-compat,
        │                          swapped in by an esbuild alias
        └── webview ◄── loopback WebSocket bridge ──┘
```

- The extension is **not forked**. Editor APIs the agent needs are
  reimplemented in `vscode-compat`:
  - symbol, definition, reference and diagnostic lookups, backed by a bundled
    `typescript-language-server`;
  - a diff panel with keep/undo per hunk;
  - secrets in the OS keychain via `@napi-rs/keyring`.
- Packaging (`scripts/stage-runtime.mjs`, `build-release.mjs`) bundles a pinned,
  checksum-verified Node together with the sidecar and its native modules.
  Every Mach-O file except Node is ad-hoc signed; Node keeps its own Developer
  ID signature, so keychain access survives updates.
- On Windows the sidecar runs in a Job Object (kill-on-close), and browsers
  and editors open through `explorer.exe` so they aren't part of it. The
  installer is NSIS, per-user and not code-signed; `install.ps1` installs it.
- `.github/workflows/desktop-publish.yml` builds both Macs and Windows on each
  `desktop-vX.Y.Z` tag. It publishes the release and points the rolling
  `desktop-latest` release (`latest.json`, `install.sh`, `install.ps1`) at it. The app's
  updater verifies each update's minisign signature and installs on quit.

Plan and phases: [design/desktop.md](design/desktop.md). Measurements and
findings: [`apps/desktop/NOTES.md`](../apps/desktop/NOTES.md).

## Other pieces

- **MCP server** (`apps/workspacegpt-mcp`): reads the same local index, so
  Cursor, Copilot, Claude Desktop and Claude Code can search it. Installed via
  the `WorkspaceGPT: Connect MCP Server` command.
- **Deployment automation** (`packages/release-core` +
  `services/deployment/`): config-sync and hotfix releases as plan → approve →
  apply. Design and connection setup:
  [design/deployment-automation.md](design/deployment-automation.md).
- **Analytics:** anonymous PostHog events (EU). Each event carries a `surface`
  of `extension` or `desktop`, and never any content.
- **Evals** (`packages/agent-evals`): headless scenarios run the real agent
  against seeded workspaces, for the extension and the desktop host
  (`--host desktop`).
