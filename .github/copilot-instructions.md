# WorkspaceGPT - AI Coding Assistant Instructions

## Project Overview

WorkspaceGPT is a **privacy-first, local-only RAG (Retrieval-Augmented Generation) system** that makes organizational knowledge instantly accessible. The monorepo contains three main applications and shared packages, all built with a focus on local data processing and zero external data transmission.

### Architecture Components

**Apps:**
- `apps/confluence-extractor` - Node.js service that extracts Confluence pages to markdown (`.data/confluence/mds`)
- `apps/confluence-rag` - Python/Streamlit chat interface using LangChain + FAISS for local RAG
- `apps/vscode-extensions` - VSCode extension providing in-editor chat with workspace/Confluence/ADO integration
- `apps/workspacegpt-webapp` - Next.js marketing/landing page
- `apps/confluence-auth-proxy` - Vercel serverless OAuth 2.0 token proxy (keeps `ATLASSIAN_CLIENT_SECRET` server-side; **not in Turbo pipeline**, deploy with `vercel --prod`)

**Shared Packages:**
- `packages/confluence-utils` - Core Confluence API client and page processing utilities (used by extractor + VSCode extension)
- `packages/eslint-config` - Shared ESLint configurations
- `packages/typescript-config` - Shared TypeScript configurations
- `packages/ui` - Shared React UI components (`button.tsx`, `card.tsx`, `code.tsx`); not yet consumed by any app
- `packages/azure-devops-utils` - Scaffolded ADO utilities (empty — work in progress)
- `packages/jira-utils` - Scaffolded Jira utilities (empty — work in progress)

## Build System & Workflows

### Monorepo Management
- **Package Manager:** pnpm with workspaces (`pnpm-workspace.yaml`)
- **Build Orchestration:** Turborepo (`turbo.json`) handles dependency graph and caching
- **Workspace Dependencies:** Use `workspace:*` protocol (e.g., `@workspace-gpt/confluence-utils`)

### Critical Commands

```bash
# Install dependencies
pnpm install

# Build entire monorepo (Turbo handles dependency order)
pnpm build

# Validate codebase
pnpm lint
pnpm check-types

# Run specific apps (uses pnpm filters)
pnpm extractor start              # Extract Confluence data
pnpm workspaceGPT start           # Start Streamlit RAG interface
pnpm app:vscode-extension build   # Build VSCode extension

# Initial setup helpers
pnpm env:setup                    # Creates .env from .env.example if missing
pnpm ollama:setup                 # Pulls default local model (llama3.2)

# Reset data
pnpm reset:extractor              # Clears .data directory
pnpm reset:workspaceGPT           # Clears vector_db directory
```

### Build Dependencies (Critical!)
1. `packages/confluence-utils` must build first (used by extractor + VSCode extension)
2. VSCode extension uses custom esbuild config with:
   - **Main extension:** CommonJS (VSCode requirement)
   - **Workers:** ESM (for @xenova/transformers support)
   - **Webview:** Built separately with Vite before extension bundling
   - Copies `@xenova/transformers` to `dist/node_modules` post-build
3. **onnxruntime-node:** Required dependency for @xenova/transformers
   - @xenova/transformers has `onnxruntime-node` as an optional dependency
   - In Node.js environments (VSCode extension workers), it uses onnxruntime-node for native performance
   - Only `onnxruntime-node` is needed; `onnxruntime-web` and `onnxruntime-common` are NOT required
   - Marked as external in esbuild config (not bundled)

## Project-Specific Conventions

### Data Flow Architecture
```
Confluence API → confluence-extractor → .data/confluence/mds/*.md
                                              ↓
                                         Python RAG service → FAISS vector DB (vector_db_standard/)
                                              ↓
                                         Streamlit UI or VSCode Extension

Azure DevOps API → adoWorker.ts (ESM) → FAISS embeddings (via @xenova/transformers)
                                              ↓
                                         VSCode Extension chat (chatService.ts)

Codebase files → codebaseWorker.ts → FAISS embeddings
                                              ↓
                                         VSCode Extension chat
```

### Key Patterns

**1. Local-First Design:** Every component operates locally - no external API calls except to Confluence source
- Ollama (llama3.2) for LLM inference
- FAISS for vector storage
- Local markdown file storage

**2. Environment Configuration:**
- Root `.env` drives both Node.js and Python apps
- Critical vars: `CONFLUENCE_BASE_URL`, `SPACE_KEY`, `API_TOKEN`, `APP_MODE` (LITE/STANDARD/EXPERT)
- `APP_MODE` also controls vector DB folder naming (for example, `vector_db_standard`)

**3. Conda Environment for Python:**
```bash
conda activate workspacegpt  # Must be active before running Python apps
# Defined in apps/confluence-rag/environment.yml
```

**4. VSCode Extension State:**
- Uses VSCode's `context.globalState` for non-sensitive persistence; `context.secrets` for sensitive tokens (PAT, OAuth tokens)
- PostHog analytics (privacy-respecting telemetry via `AnalyticsService`)
- Webview built separately with Vite (`webview/` subdirectory); uses **Zustand** for state management (`chatStore`, `modelStore`, `settingsStore`)
- Auto-starting schedulers on activation: `ConfluenceSyncScheduler` and `AdoSyncScheduler`

**5. Confluence Authentication (OAuth 2.0 3LO):**
- `ConfluenceAuthService` implements a full three-legged OAuth flow — spins up a local `http.Server` callback handler on activation
- Uses CSRF state parameter; persists `OAuthTokens` (accessToken + refreshToken + expiresAt) via `context.secrets`
- Token exchange is proxied through `apps/confluence-auth-proxy` (Vercel) to keep `ATLASSIAN_CLIENT_SECRET` server-side
- Required env vars for proxy: `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`

**6. Azure DevOps (ADO) Integration:**
- `AdoAuthService` stores PAT in `context.secrets` (never `globalState`)
- Auth header: `Basic base64(:PAT)` as required by Azure DevOps REST API
- `AdoSyncScheduler` starts automatically on extension activation (alongside Confluence scheduler)
- Full handler/service/worker trilogy: `AdoMessageHandler` → `AdoService` → `adoWorker.ts` (ESM)

### File Naming & Structure

**Confluence Utils Package:**
- `src/utils/fetchPages.ts` - Main API client (`ConfluencePageFetcher`)
- `src/utils/processPage.ts` - Converts Confluence HTML → Markdown
- Uses Puppeteer for JavaScript-heavy page rendering

**Python RAG Service:**
- `src/main.py` - Core `WorkspaceAssistant` class
- `src/chat.py` - Streamlit UI with streaming responses
- `utils/chain_setup.py` - LangChain configuration
- `utils/embeddings.py` - FAISS vector DB operations

**VSCode Extension Source Layout:**
```
src/
  extension.ts              # Activation: registers services, schedulers, commands
  webViewprovider.ts
  handlers/
    WebviewMessageHandler.ts  # Routes all webview messages to sub-handlers
    ChatMessageHandler.ts
    ConfluenceMessageHandler.ts
    AdoMessageHandler.ts      # ADO PAT save/disconnect, sync, indexing
    CodebaseMessageHandler.ts
    SystemMessageHandler.ts
  services/
    analyticsService.ts       # PostHog (eu.i.posthog.com)
    chatService.ts
    historyService.ts
    confluence/               # confluenceAuthService, confluenceEmbeddingService, ...
    ado/                      # adoAuthService, adoEmbeddingService, adoService, adoSyncScheduler
    codebase/
    jira/                     # Empty placeholder
  workers/
    confluence/confluenceWorker.ts
    ado/adoWorker.ts          # ESM worker for ADO data
    codebase/                 # codebaseWorker, codebaseCountWorker, codebaseSearchWorker
    model/modelWorker.ts
    common/                   # createEmbeddingForText, searchProcess
    utils/initializeEmbeddingModel.ts
    jira/                     # Empty placeholder
```

## Testing & Development

### Monorepo Build Tasks
- Prefer VS Code task `build:all` for local dependency-safe builds (clean -> utils -> extractor)
- `build:confluence-extractor` depends on `build:utils`

### VSCode Extension Development
```bash
cd apps/vscode-extensions
pnpm run dev  # Builds and opens new VSCode window with extension loaded
```
- Press F5 in VSCode to launch Extension Development Host
- Webview runs separately: `cd webview && pnpm run dev`

### Testing Reality
- Most validation in this repo is currently build/lint/type-check oriented (`pnpm build`, `pnpm lint`, `pnpm check-types`)
- VSCode extension has a `test` script, but broader automated test coverage is limited across apps

### Common Issues

**"Cannot find module @workspace-gpt/confluence-utils"**
→ Run `pnpm build` from root to build shared packages first

**Python import errors**
→ Ensure `conda activate workspacegpt` is active

**Streamlit module not found**
→ Activate the conda env first, then rerun `pnpm workspaceGPT start`

**VSCode extension not loading**
→ Check `dist/node_modules/@xenova/transformers` exists (should be copied by esbuild config)

**Embedding/search failures in VSCode extension**
→ Ensure `onnxruntime-node` is installed (required by @xenova/transformers for Node.js backend)
→ Check that `onnxruntime-node` is marked as external in `esbuild.config.js`

**ADO sync not working**
→ Verify PAT is saved via the ADO settings panel (stored in `context.secrets`)
→ PAT must have read access to Azure DevOps work items and projects

**Confluence OAuth flow failing**
→ Ensure `confluence-auth-proxy` is deployed to Vercel with correct `ATLASSIAN_CLIENT_ID` / `ATLASSIAN_CLIENT_SECRET`
→ Local callback server starts on activation — ensure no firewall blocks the ephemeral port

## Integration Points

### Confluence API
- Uses Atlassian REST API v2
- Batched fetching (default 10 pages per batch)
- Rate limiting: 1000ms between batches
- Authentication: OAuth 2.0 (3LO) in VSCode extension; Basic auth (email + API token) in extractor/Python apps
- OAuth token proxy: `apps/confluence-auth-proxy` (deploy separately to Vercel)

### Azure DevOps API
- PAT-based authentication (stored in VSCode `secrets`, never `globalState`)
- Auth header format: `Basic base64(:PAT)` (colon-prefixed PAT)
- Sync handled by worker (`adoWorker.ts`) with incremental progress reporting

### LLM Integration
- Ollama default model: `llama3.2:1b` (can upgrade to `llama3.2:4b`, `mistral`, etc.)
- Cloud providers supported in VSCode extension: OpenAI, Gemini, Groq, OpenRouter
- Streaming responses using LangChain callbacks

### Vector Database
- FAISS (Facebook AI Similarity Search) for local embeddings
- HuggingFace sentence-transformers for embeddings
- Stored in `vector_db_standard/` with `.faiss` index files

## VS Code Tasks
Use `.vscode/tasks.json` tasks for common operations:
- `build:all` - Sequential build: clean → utils → extractor
- `build:confluence-extractor` - Build extractor with utils dependency
- Individual clean/build tasks available per package

## Security & Privacy Notes
- **No data leaves local environment** (except Confluence API calls during extraction)
- Sensitive configs in `.env` (never commit)
- VSCode extension uses local embeddings via @xenova/transformers (no API calls)

## When Adding New Features

1. **New data source?** → Create extractor in `apps/`, reuse `confluence-utils` patterns
2. **New VSCode integration (e.g., Jira)?** → Follow the ADO pattern: `Handler → Service → Worker`; stub dirs already exist in `services/jira/` and `workers/jira/`
3. **Shared utilities?** → Add to `packages/confluence-utils` or create new package; `packages/azure-devops-utils` and `packages/jira-utils` are pre-scaffolded
4. **Python dependencies?** → Update `apps/confluence-rag/environment.yml`, run `pnpm app:confluence-rag env:update`
5. **Node dependencies?** → Use `pnpm add -w <pkg>` for workspace root, or navigate to specific package
6. **New worker?** → Place in `src/workers/<integration>/`, built as ESM automatically by `getAllFiles()` in esbuild config

## Documentation References
- Main README: `/README.md` - User setup guide
- VSCode Extension: `/apps/vscode-extensions/README.md` - Extension features & setup
- Turbo docs: https://turbo.build/repo/docs
- pnpm workspaces: https://pnpm.io/workspaces
