# Working in this repo

WorkspaceGPT is a coding agent grounded in an org's Confluence, Jira and Azure
DevOps knowledge. pnpm workspaces + Turborepo; Node >= 18, pnpm 9. Read
docs/architecture.md before large changes, and docs/north-star.md before
proposing features.

## Where things are
- `apps/vscode-extensions`: the product. Host in `src/`: webview messages go
  handlers → services → workers (worker threads under `src/workers/`; the agent
  loop is `src/workers/model/modelWorker.ts`). React + Zustand webview in
  `webview/`. Constants in `constants.ts`.
- `apps/desktop`: Tauri shell (`src-tauri/`, Rust) + Node sidecar (`sidecar/`)
  that runs the extension unmodified. The `vscode` module is
  `sidecar/vscode-compat/`, swapped in by an esbuild alias. Findings live in
  `apps/desktop/NOTES.md`.
- `apps/workspacegpt-mcp` (MCP server), `apps/workspacegpt-api` (Cloudflare
  Worker for Remote mode), `apps/confluence-auth-proxy` (Vercel OAuth secrets),
  `apps/workspacegpt-webapp` (Next.js site; `main` deploys to production).
- `packages/agent-evals` (eval harness + unit tests), `packages/release-core`,
  `packages/embedding-core`, `packages/confluence-utils`.
- Legacy, don't extend: `apps/confluence-extractor`, `apps/confluence-rag`,
  and `apps/chrome-extension` (parked).

## Commands
```bash
pnpm install
pnpm build && pnpm lint && pnpm check-types     # whole repo (Turbo)
pnpm app:vscode-extension build                  # extension + webview
pnpm --filter @workspace-gpt/agent-evals units   # agent unit tests
pnpm --filter desktop dev                        # desktop app (needs Rust)
pnpm --filter workspacegpt-webapp dev            # site on :3000
```
Debug the extension with F5 (Extension Development Host) from
`apps/vscode-extensions`.

## Rules
- Smallest diff that fixes the problem. Add lines rather than refactoring code
  you weren't asked to touch.
- Fix the class of defect, not the instance. A regex over user text may only
  add a detection; it must never gate capability or budget.
- Knowledge sources (Confluence, Jira, Azure DevOps) are the product. In UI copy
  call them "Knowledge" and each by its name, never "integrations" or
  "plugins".
- Privacy is architecture. Indexing and embeddings stay on-device in both modes.
  Secrets go in the host's secret storage, never in settings or globalState.
  Analytics events never carry content.
- Desktop: don't fork extension code for it. Add what's missing to
  `vscode-compat`, or gate UI on `isDesktopHost()`.
- Never commit `.env`, `.dev.vars` or keys. The repo is public.
