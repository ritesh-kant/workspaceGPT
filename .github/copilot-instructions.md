# WorkspaceGPT - AI Coding Assistant Instructions

## Project Overview

WorkspaceGPT is a **privacy-first, local-only RAG (Retrieval-Augmented Generation) system** that makes organizational knowledge instantly accessible. The monorepo contains three main applications and shared packages, all built with a focus on local data processing and zero external data transmission.

### Architecture Components

**Apps:**
- `apps/confluence-extractor` - Node.js service that extracts Confluence pages to markdown (`.data/confluence/mds`)
- `apps/confluence-rag` - Python/Streamlit chat interface using LangChain + FAISS for local RAG
- `apps/vscode-extensions` - VSCode extension providing in-editor chat with workspace/Confluence integration
- `apps/workspacegpt-webapp` - Next.js marketing/landing page

**Shared Packages:**
- `packages/confluence-utils` - Core Confluence API client and page processing utilities (used by extractor + VSCode extension)
- `packages/eslint-config` - Shared ESLint configurations
- `packages/typescript-config` - Shared TypeScript configurations

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

# Run specific apps (uses pnpm filters)
pnpm extractor start              # Extract Confluence data
pnpm workspaceGPT start           # Start Streamlit RAG interface
pnpm app:vscode-extension build   # Build VSCode extension

# Reset data
pnpm reset:extractor              # Clears .data directory
pnpm reset:workspaceGPT           # Clears vector_db directory
```

### Build Dependencies (Critical!)
1. `packages/confluence-utils` must build first (used by extractor + VSCode extension)
2. VSCode extension uses custom esbuild config with:
   - **Main extension:** CommonJS (VSCode requirement)
   - **Workers:** ESM (for @xenova/transformers support)
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
```

### Key Patterns

**1. Local-First Design:** Every component operates locally - no external API calls except to Confluence source
- Ollama (llama3.2) for LLM inference
- FAISS for vector storage
- Local markdown file storage

**2. Environment Configuration:**
- Root `.env` drives both Node.js and Python apps
- Critical vars: `CONFLUENCE_BASE_URL`, `SPACE_KEY`, `API_TOKEN`, `APP_MODE` (LITE/STANDARD/EXPERT)

**3. Conda Environment for Python:**
```bash
conda activate workspacegpt  # Must be active before running Python apps
# Defined in apps/confluence-rag/environment.yml
```

**4. VSCode Extension State:**
- Uses VSCode's `context.globalState` for persistence
- PostHog analytics (privacy-respecting telemetry)
- Webview built separately with Vite (webview/ subdirectory)

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

## Testing & Development

### VSCode Extension Development
```bash
cd apps/vscode-extensions
pnpm run dev  # Builds and opens new VSCode window with extension loaded
```
- Press F5 in VSCode to launch Extension Development Host
- Webview runs separately: `cd webview && pnpm run dev`

### Common Issues

**"Cannot find module @workspace-gpt/confluence-utils"**
→ Run `pnpm build` from root to build shared packages first

**Python import errors**
→ Ensure `conda activate workspacegpt` is active

**VSCode extension not loading**
→ Check `dist/node_modules/@xenova/transformers` exists (should be copied by esbuild config)

**Embedding/search failures in VSCode extension**
→ Ensure `onnxruntime-node` is installed (required by @xenova/transformers for Node.js backend)
→ Check that `onnxruntime-node` is marked as external in `esbuild.config.js`

## Integration Points

### Confluence API
- Uses Atlassian REST API v2
- Batched fetching (default 10 pages per batch)
- Rate limiting: 1000ms between batches
- Authentication: Basic auth (email + API token)

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
2. **Shared utilities?** → Add to `packages/confluence-utils` or create new package
3. **Python dependencies?** → Update `apps/confluence-rag/environment.yml`, run `pnpm app:confluence-rag env:update`
4. **Node dependencies?** → Use `pnpm add -w <pkg>` for workspace root, or navigate to specific package

## Documentation References
- Main README: `/README.md` - User setup guide
- VSCode Extension: `/apps/vscode-extensions/README.md` - Extension features & setup
- Turbo docs: https://turbo.build/repo/docs
- pnpm workspaces: https://pnpm.io/workspaces
