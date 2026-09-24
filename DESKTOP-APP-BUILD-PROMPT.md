# Build Prompt: WorkspaceGPT Desktop App

> Copy everything below the line into a coding agent (Claude Code / Cline /
> Cursor) working at the root of this monorepo. It is self-contained.

---

## Mission

Build **WorkspaceGPT Desktop** — a standalone desktop app (macOS first, then
Windows/Linux) that wraps the WorkspaceGPT org-knowledge RAG system in a coding
agent shell, **without** depending on VS Code. Positioning (from
`NORTH-STAR.md`): *the coding agent that knows your whole org, and can prove it
never stores your data.* Local-first by default (Ollama + local embeddings +
local vector store); cloud providers optional and user-configured.

## Architecture decision (already made — do not relitigate)

**Do NOT build an agent harness from scratch and do NOT fork Cline.** Use
`@cline/sdk` (Apache 2.0, `npm install @cline/sdk`, requires Node 22+) as the
agent runtime — the same harness that powers Cline's desktop app, CLI, and IDE
extensions. Our differentiation is the knowledge layer, not the agent loop:

```
┌────────────────────────────────────────────────────────────┐
│ Electron shell (apps/desktop)                              │
│  main process: window mgmt, IPC, auto-updater, secrets     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Renderer: React webview REUSED from                  │  │
│  │ apps/vscode-extensions/webview (extract to           │  │
│  │ packages/chat-ui) — only the transport bridge changes│  │
│  └──────────────────────┬───────────────────────────────┘  │
└─────────────────────────│──────────────────────────────────┘
                          │ IPC (typed message bus)
┌─────────────────────────▼──────────────────────────────────┐
│ Agent host (runs in Electron main, or a child process):    │
│  @cline/sdk Agent runtime                                  │
│   ├─ MCP: @workspace-gpt/mcp-server registered by default  │
│   │   (Confluence + Azure DevOps search — already built)   │
│   ├─ Custom tools: search_confluence, search_ado,          │
│   │   sync_index, list_sources (wrapping packages/         │
│   │   embedding-core + existing extractor logic)           │
│   └─ Providers: Ollama (default), OpenAI-compatible,       │
│       Gemini, Groq — BYOK, keys in OS keychain             │
└────────────────────────────────────────────────────────────┘
```

## Repository facts (verified — rely on these)

- pnpm 9 + turbo monorepo. Workspaces: `apps/*`, `packages/*`.
- Agent-relevant existing code:
  - `apps/vscode-extensions/src` — extension host (~35k LOC). 68 files import
    `vscode`. **Do not refactor it in this project** — the extension keeps
    shipping as-is. Desktop is additive.
  - `apps/vscode-extensions/webview` — React 19 + Vite chat UI (~14.6k LOC,
    components: ChatMessage, AgentTimeline, Settings, ChatHistorySidebar,
    MentionPicker, etc.). Bridge is `webview/src/vscode.ts`
    (`acquireVsCodeApi().postMessage`).
  - `apps/workspacegpt-mcp` — `@workspace-gpt/mcp-server`, stdio MCP server,
    `bin: workspacegpt-mcp`, built with tsup. Exposes Confluence + ADO search.
  - `packages/embedding-core` — `@workspace-gpt/embedding-core` (ESM, exports
    `./src/index.ts`): Gemini + ONNX embedding providers, Qdrant + local file
    vector stores, `makeVectorStore`, `checkEmbeddingCompat`, embedding
    manifest `{provider, model, dimensions, normalized}`.
  - `apps/confluence-extractor`, `packages/confluence-utils`,
    `packages/azure-devops-utils` — indexing pipeline pieces.
- Embedding invariant (from `ARCHITECTURE.md`): corpus and query MUST share one
  embedding model/vector space. ONNX (384-dim) and Gemini (768-dim) are
  incompatible. Always check the index manifest before searching; fail loud on
  mismatch via `checkEmbeddingCompat`.

## Hard constraints

1. **Local-first by default.** Out of the box: Ollama chat model + ONNX local
   embeddings + local file vector store. Nothing leaves the machine unless the
   user opts into a cloud provider in Settings.
2. **The VS Code extension must keep working.** No edits to
   `apps/vscode-extensions/src` except extracting the webview into
   `packages/chat-ui` — and even that must land as a pure move with the
   extension's build updated, all existing behavior identical.
3. **No secrets in plaintext.** API keys via OS keychain (Electron
   `safeStorage`), never in config files or logs.
4. **pnpm workspaces + turbo** for all new packages/apps. TypeScript strict.
   Prettier for formatting (`pnpm format`).
5. **Node 22+** (required by `@cline/sdk`).
6. Every phase ends green: `pnpm build`, `pnpm check-types`, and the app
   actually launching and completing one grounded Q&A round-trip.


## Phase plan

### Phase 0 — Spike: prove `@cline/sdk` + our MCP works (0.5–1 day)

Create `apps/desktop-spike` (plain Node script, no UI):

1. `pnpm add @cline/sdk` (workspace-scoped).
2. Instantiate an `Agent` with provider `ollama` (model `llama3.2`,
   `baseUrl http://localhost:11434`) and register
   `@workspace-gpt/mcp-server` as an MCP server (stdio, `node
   apps/workspacegpt-mcp/dist/index.js`).
3. Subscribe to events, stream `assistant-text-delta` to stdout.
4. Run one task: *"Using the confluence search tool, answer: <sample question
   over an indexed space>"* and print tool calls made.
5. Also verify a custom tool path: wrap `search_confluence` via the SDK's
   `createTool` as an alternative to MCP.

**Acceptance:** grounded answer printed, tool call visible in event stream,
works offline with Ollama. Document gotchas (SDK version pinned, API shape) in
`apps/desktop-spike/NOTES.md` — everything later depends on these findings.

### Phase 1 — Extract `packages/chat-ui` (2–3 days)

1. Move `apps/vscode-extensions/webview` → `packages/chat-ui`
   (`@workspace-gpt/chat-ui`), exported as a library (Vite lib mode or source
   exports, matching how `packages/embedding-core` is consumed).
2. Introduce a **transport interface** replacing `vscode.ts`:

   ```ts
   // packages/chat-ui/src/transport.ts
   export interface ChatTransport {
     postMessage(msg: unknown): void;
     onMessage(cb: (msg: unknown) => void): () => void; // returns unsubscribe
     getState?(): unknown;
     setState?(state: unknown): void;
   }
   ```

   Provide `VSCodeTransport` (wraps `acquireVsCodeApi`) and
   `ElectronTransport` (wraps `window.desktopBridge`, injected via
   `contextBridge`). The UI picks the transport via a React provider.
3. Update the extension's Vite build + `webViewprovider.ts` to consume
   `packages/chat-ui`. Extension behavior must be byte-identical.
4. Replace VS Code theme CSS variables with a small theme adapter that maps
   them to CSS custom properties, defaulting to a bundled dark/light theme when
   not inside VS Code.

**Acceptance:** extension builds and works exactly as before; a plain
`vite dev` page in `packages/chat-ui/examples` renders the UI against a mock
transport.

### Phase 2 — Agent host package `packages/agent-host` (3–4 days)

A platform-neutral Node package that owns the agent runtime:

1. `AgentHost` class wrapping `@cline/sdk`: session create/send/stop/abort,
   event fan-out over a typed message channel.
2. Default registrations: `@workspace-gpt/mcp-server` (spawned as stdio child
   process), plus custom tools built with the SDK's `createTool`:
   - `search_confluence(query, topK)` — embed query with the provider from the
     active index manifest, search the active vector store, return chunks with
     source URLs. MUST call `checkEmbeddingCompat` first and surface a clear
     error on mismatch.
   - `search_ado(query, topK)` — same for Azure DevOps work items.
   - `list_sources()` and `sync_index(source)` — thin wrappers over existing
     extractor/indexing code (`apps/confluence-extractor`,
     `packages/confluence-utils`, `packages/azure-devops-utils`), refactored
     just enough to import without VS Code.
3. `SettingsStore` interface + file-backed impl
   (`~/.workspacegpt-desktop/settings.json`) mirroring the extension's
   `getEmbeddingSettings` / `getVectorStoreSettings` / `getLlmSettings` shapes
   so both products read the same concepts.
4. `SecretsStore` interface (impl provided by the shell: `safeStorage` in
   Electron; keep an in-memory impl for tests).
5. Message protocol: reuse the extension's webview message shapes where they
   exist (`types/` in the extension) so Phase 1's UI works unchanged. Define
   them once in `packages/chat-ui/src/protocol.ts` (or a new
   `packages/protocol`) and import from both sides.

**Acceptance:** a Node REPL/test can start `AgentHost`, ask a question, and
get a streamed, tool-grounded answer with zero Electron and zero VS Code
imports (enforce with a lint rule or madge check).

### Phase 3 — Electron shell `apps/desktop` (4–5 days)

Use **electron-vite** (React renderer) + **electron-builder**:

1. **Main process:** `AgentHost` from Phase 2, `ipcMain` handlers bridging
   renderer messages, `BrowserWindow`, single-instance lock,
   `safeStorage`-backed `SecretsStore`.
2. **Preload:** `contextBridge.exposeInMainWorld('desktopBridge', {postMessage,
   onMessage})` — exactly matching `ElectronTransport` from Phase 1.
   `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.
3. **Renderer:** `packages/chat-ui` with `ElectronTransport`.
4. **First-run experience:** detect Ollama (`GET
   http://localhost:11434/api/tags`); if missing, guided install screen
   (download link + `ollama pull llama3.2` progress); if no index exists, a
   "Connect a source" onboarding (Confluence / ADO) that triggers `sync_index`.
5. **Desktop-native basics:** project/folder picker (agent cwd), menu bar,
   Cmd/Ctrl+K new chat, native notifications on task completion, window state
   persistence.
6. **Updates:** electron-updater against GitHub Releases (repo already
   publishes per-platform artifacts; follow that pattern). macOS signing +
   notarization wired in CI (env-gated secrets initially).

**Acceptance:** packaged `.dmg` launches on a clean macOS machine, walks
through Ollama setup, indexes a Confluence space, and answers a grounded
question with citations — fully offline.

### Phase 4 — Desktop-only differentiators (post-MVP, by value)

1. **Parallel sessions** — multiple agent sessions side by side, each with its
   own cwd/branch (`AgentHost` must already support multiple sessions).
2. **Scheduled tasks** — cron-driven prompts (SDK has scheduling support;
   persist jobs, run headless, notify on completion).
3. **Multi-project window** — switch workspaces; per-project index manifest.
4. **Share-to-desktop** — reuse the share-code idea from `ARCHITECTURE.md` so a
   VS Code user can hand a desktop install its Gemini/Qdrant/LLM bundle.
5. **Global hotkey** quick-ask window.

## Explicit non-goals for MVP

- No JetBrains/other-IDE ports. No CLI (the SDK makes it cheap later — defer).
- No team/multi-user features, no hosted service, no login.
- No refactoring of `apps/vscode-extensions/src` beyond the webview move.
- No forking or vendoring Cline source — `@cline/sdk` is an npm dependency,
  version-pinned, upgraded deliberately.
- No Windows/Linux polish until macOS MVP is validated (electron-builder
  targets stay configured but untested).

## Risks to watch (flag these in code reviews as you go)

- **SDK churn:** `@cline/sdk` is young. Pin the exact version; wrap *every*
  SDK touchpoint behind `packages/agent-host` so an SDK upgrade is a
  one-package change.
- **ONNX in Electron:** `onnxruntime-node` native binaries must be unpacked
  from the asar (`asarUnpack` in electron-builder config) and rebuilt per
  platform (`electron-rebuild`). Test the packaged app, not just dev mode.
- **Embedding invariant:** never let Settings allow a mix that violates the
  manifest check (see `ARCHITECTURE.md` — "Gemini everywhere").
- **Two-product drift:** protocol/types live in shared packages only. If you
  find yourself copying a type between extension and desktop, stop and extract.
- **MCP child-process lifecycle:** kill stdio MCP children on quit; handle
  spawn failures with a visible Settings error, not a silent no-tools agent.

## Definition of done (MVP)

1. `pnpm build && pnpm check-types` green at repo root.
2. VS Code extension unchanged in behavior (manual smoke: ask a question,
   sync a source, share-to-Chrome code generation).
3. `apps/desktop` packaged dmg: fresh machine → Ollama onboarding → connect
   Confluence → ask → grounded answer with sources → works with Wi-Fi off.
4. `apps/desktop-spike/NOTES.md` + a short `apps/desktop/README.md` (run,
   build, package, release).

