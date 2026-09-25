# WorkspaceGPT Desktop (Tauri) — Plan

Status: Phases 0–3 built (headless spike, Tauri shell, agent tool parity, macOS packaging). desktop-v0.0.1 released 2026-09-25; the 0.0.1 → 0.0.2 in-app update was verified through the public release the same day. Windows and Linux not started.
Earlier status: Phase 0 (headless spike) and Phase 1 (Tauri shell) built 2026-09-24
on branch `desktop/phase-0`. Results, measurements and every compat API hit
are in `apps/desktop/NOTES.md`. Written 2026-09-24.
Supersedes an earlier build prompt (removed 2026-09-25; it assumed `@cline/sdk`,
Ollama-by-default and "no login"; all three are wrong for today's product).

## Goal

A standalone desktop app for the same agent the VS Code extension ships —
org-grounded (Confluence, ADO, Jira), remote-mode inference by default
(glm-5.3-flash via the Worker), indexing local — for users who don't live in
VS Code. The extension keeps shipping unchanged.

## The fact that shapes the whole plan

The agent loop is **already outside VS Code**. `src/workers/model/modelWorker.ts`
(3.6k lines) and the rest of `src/workers/**` (8.3k lines total) import
nothing from `vscode`. They run in a `worker_thread` spawned by
`chatService.ts:483` / `:2592` and ask the host to run tools over a message
protocol:

```
modelWorker ── tool_request {id,name,arguments} ──▶ chatService.executeCodebaseTool
            ◀─ tool_response {id,result} ────────
            ── chunk / done / tool_status / tool_step_update / key_failover ──▶
```

So the desktop port is **not** "extract the agent". It is "give the host side
(`chatService` + tool implementations + message handlers) a non-VS-Code
runtime". That is a much smaller job than Cline's, which was a full runtime
rewrite that still hasn't landed in their own IDE extension.

Measured VS Code coupling on the host side:

| Area | `vscode.` refs | Desktop replacement |
|---|---|---|
| `codebase/codebaseTools.ts` | 38 | `fs` + ripgrep (already bundled `@vscode/ripgrep`) for search/read/list; LSP client for definition/references/symbols |
| `agent/agentHunkLens.ts`, `agentDiffProvider.ts` | 36 | Not ported — replaced by a diff view in the React UI |
| `agent/agentWriteTools.ts` | 12 | `fs` writes (the write gate and checkpoints are already vscode-free) |
| `agent/inspectTools.ts` | 5 | `get_diagnostics` from `tsc`/`eslint` output instead of `vscode.languages.getDiagnostics` |
| `commandTools`, `verifyTools`, `shipService` | 8 | Mostly `workspaceFolders`/output — trivial |
| `context.globalState` | 152 calls | JSON key-value file |
| `context.secrets` | 45 calls | OS keychain |
| `context.globalStorageUri` | 26 calls | App data dir |
| Remote sign-in | — | Already uses a loopback OAuth callback server — works as-is; `openExternal` → system browser |

Already vscode-free and reused as-is: `modelWorker` + `answerGates`,
`autoVerify`, `contextBudget`, `exploreSubagent`, the ADO/Confluence/Jira
workers, `checkpointService`, `agentWriteGate`, `referenceIndex`,
`resumeStore`, `gitStatusService`, `rulesFiles`, `shipHelpers`.

## Architecture

Same shape as Cline Desktop (Tauri shell, JS sidecar, UI over loopback
WebSocket), with **Node instead of Bun** for the sidecar.

```
┌─ Tauri shell (Rust, small) ─────────────────────────────────────┐
│ window, tray, menu, folder picker, updater, deep link,          │
│ spawns + supervises the sidecar (Job Object / process group)    │
│  ┌─ Webview (WKWebView / WebView2 / WebKitGTK) ──────────────┐  │
│  │ EXISTING apps/vscode-extensions/webview build, unchanged, │  │
│  │ + desktop-bridge.js that defines window.acquireVsCodeApi  │  │
│  │   over WebSocket (same trick as webview/tools/preview.mjs)│  │
│  └───────────────────────┬───────────────────────────────────┘  │
└──────────────────────────│──────────────────────────────────────┘
                           │ ws://127.0.0.1:<random>/?t=<per-launch token>
┌─ Node sidecar (bundled Node 22 binary) ─▼────────────────────────┐
│ esbuild bundle of the extension host code with                   │
│   `vscode` aliased → apps/desktop/sidecar/vscode-compat/*        │
│ chatService, handlers, services → unchanged source               │
│ modelWorker + index workers → worker_threads, unchanged          │
│ onnxruntime-node, ripgrep, keyring → shipped unpacked            │
└──────────────────────────────────────────────────────────────────┘
```

### Decision 1 — Node sidecar, not Bun

Cline chose Bun for fast startup and a single compiled binary. We can't take
that yet: the host code depends on `worker_threads` semantics,
`onnxruntime-node` native addons (N-API, pinned 1.14.0), `@xenova/transformers`
with a postinstall patch, and `@azure/msal-node`. Every one is a compatibility
question on Bun; on Node they already work in the extension host. Cost: ~40 MB
more download and slower cold start (~200–400 ms). Revisit after MVP.

Node SEA (single executable) can't embed native `.node` addons cleanly, so
ship the Node binary + `dist/` + a pruned `node_modules` (native packages
only) as Tauri resources, the way the DeepSeek community desktop does.

### Decision 2 — a `vscode` compatibility module first, real interfaces later

Two ways to cut the host off VS Code:

- **(A) `HostServices` interface** threaded through `chatService` and the
  tools. Clean, but touches `chatService.ts` (3.2k lines) and dozens of files
  in the shipping extension, which breaks the minimal-diff rule and risks
  the extension.
- **(B) Compat module** (Cline did this: `apps/vscode/standalone/runtime-files/vscode/`):
  the sidecar's esbuild config aliases `vscode` to our own module that
  implements the ~50 APIs actually used (list above). **Zero edits to
  extension source.**

**Choose B for MVP.** It gets the real agent running in the desktop in days
and cannot regress the extension. Guardrails so it doesn't become a hidden
mess:

1. The compat module implements only what a checked-in usage list names, and
   anything else throws `NotSupportedInDesktop(<api>)` — loud, never silent.
2. A CI script regenerates the `vscode.*` usage list from `src/` and fails when
   new usage appears that the compat module doesn't cover. This catches drift
   the day it's introduced.
3. For the LSP, diff and diagnostics APIs (the ones with no honest shim),
   replace them one at a time with small seams in the extension source
   (a `host.lsp` / `host.diagnostics` indirection), each as its own
   minimal PR.

### Decision 3 — the UI talks over loopback WebSocket, not Tauri IPC

This is what Cline does. It means:
- The whole app runs headless in a browser (`pnpm desktop:dev:headless`),
  which extends the existing preview harness instead of replacing it.
- The sidecar can restart without losing the window.
- The webview bundle needs **no source changes**: `desktop-bridge.js`
  defines `window.acquireVsCodeApi()` returning `{postMessage, getState,
  setState}` backed by the socket, and replays host→webview messages as
  `window` `message` events, which is exactly the interface `webview/src/vscode.ts` uses.

Security: bind to `127.0.0.1` on a random port, require a per-launch token
(injected by Tauri into the webview via an initialization script, never in a
URL that's logged), and check the `Origin` header (`tauri://localhost`,
`http://tauri.localhost`, and the dev origin only).

*As built (Phase 1):* the Tauri window loads the page straight from the
sidecar (`http://127.0.0.1:<port>/`) rather than bundling the webview as
`tauri://` assets, so the extension's own `WebviewHtmlTemplate` (CSP included)
produces the page in both headless and native modes. The **shell** generates
the token and hands it to the sidecar as the first stdin line, so it survives a
sidecar restart (only the port changes). The Host header is checked too (DNS
rebinding). Headless mode passes its token in the URL fragment, which is never
sent to a server.

Tauri `invoke` is used only for things the webview can't do: window
controls, folder picker, updater, open external URL.

## Challenges and how each is handled

| # | Challenge | Handling |
|---|---|---|
| 1 | **No language server.** `find_references`, `go_to_definition`, `find_symbol` use `vscode.execute*Provider`. | MVP: `find_symbol` uses ripgrep; definition/references run a real LSP client (`typescript-language-server` over stdio, via `vscode-languageserver-protocol`) started lazily per workspace root. Other languages later. Say what's missing in the tool result instead of returning empty. |
| 2 | **No diagnostics feed.** `get_diagnostics` reads VS Code's problem list. | Run `tsc --noEmit` / eslint (the scoped command resolution `autoVerify` already uses) and parse the output. Slower, so cache per file mtime. |
| 3 | **Diff review UI.** `agentHunkLens` / `agentDiffProvider` are CodeLens + a virtual document. | New React diff panel in the webview (per-hunk accept/reject → the existing write gate). Only UI work in the plan that isn't reuse. |
| 4 | **WebKit, not Chromium.** The webview has only ever run in Chromium (VS Code). | Test in Safari from day one (headless mode makes this free). Watch for `visualViewport`, CSS `:has`, scrollbar styling, drag-drop. The VS Code-only sidebar collapse logic in `vscode.ts` goes inert because the desktop never sends `VIEW_VISIBILITY` or honours `COLLAPSE_SIDEBAR`. |
| 5 | **Theme variables.** UI styles read `--vscode-*`. | Ship the same variable set `webview/tools/preview.mjs` injects, as light/dark themes. |
| 6 | **Orphaned processes.** Sidecar → worker threads → MCP servers → `run_command` / `run_checks` children (the 20 GB jest run). Cline shipped with an orphaned-sidecar bug on Windows. | Rust puts the sidecar in a Windows **Job Object** (`KILL_ON_JOB_CLOSE`) / a process group on macOS/Linux. The sidecar exits when its stdin closes (parent-death watchdog). Commands already run with tree-kill. Test "force-quit the app mid-`run_checks`" on every platform. *Found in Phase 1:* `run_command`/`run_checks` children are spawned `detached` (their own process group, for tree-kill), which puts them **outside** the sidecar's group, so a group kill misses them. The sidecar now tracks every child it spawns (`host/processReaper.ts`) and kills each one's group on shutdown; verified with `kill -9` of the app mid-run. |
| 7 | **PATH when launched from Finder.** Apps opened from Finder don't inherit the shell PATH, so `pnpm`, `node`, `gh` and `git` from Homebrew/nvm aren't found. This would break `run_checks` quietly. | At sidecar start, read the user's login shell (`$SHELL -ilc 'env -0'` with a timeout) and merge its PATH, as Cline does. Show the resolved PATH in Settings → Diagnostics. *Found in Phase 0:* with nvm + conda in `.zshrc` the probe sometimes takes more than 3 s, so the first launch waits up to 8 s and saves the result; later launches use the saved PATH at once and refresh it in the background. |
| 8 | **Signing native code.** No paid Apple Developer ID for MVP (decided 2026-09-24: no $99/yr). Apple Silicon still refuses fully unsigned code. | **Ad-hoc sign** everything (`signingIdentity: "-"`), including the Node binary, every `.node` addon and ripgrep. It's free and needs no account. Primary install path is `curl … /install.sh \| sh`: curl sets no quarantine flag, so Gatekeeper doesn't prompt, and the Tauri updater downloads the same way. The DMG on GitHub Releases is secondary, with "Privacy & Security → Open Anyway" / `xattr -dr com.apple.quarantine` instructions. Updater manifests are signed with Tauri's own free key pair (`tauri signer generate`). Revisit Developer ID + notarization (entitlements: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`) if an org wants to deploy it through MDM. Windows: unsigned for MVP (SmartScreen "More info → Run anyway"). Linux: AppImage unsigned. |
| 9 | **Per-architecture native builds.** onnxruntime-node and ripgrep are per-arch. | Build per-target (darwin-arm64, darwin-x64, win32-x64, linux-x64), reusing the matrix `scripts/publish-targets.mjs` already runs for `.vsix` targets. Don't build a macOS universal binary; ship two DMGs. |
| 10 | **Secrets.** `context.secrets` (45 calls). | `@napi-rs/keyring` in the sidecar (prebuilt, maintained; `keytar` is archived). One service name, keys namespaced like the extension's. |
| 11 | **State and data location.** `globalState` / `globalStorageUri`. | `globalState` → `<appData>/state.json` (atomic write + rename). `globalStorageUri` → `<appData>/storage/`. Do **not** share the extension's directory: two processes writing `chats/*.json` would repeat the stale-history overwrite bug. "Import from VS Code" can come later as a one-shot copy. |
| 12 | **Remote-mode sign-in.** | The loopback OAuth callback server already works outside VS Code. `vscode.env.openExternal` → Tauri opener. Register a `workspacegpt://` deep link for later, not needed for MVP. |
| 13 | **`vscode.env.machineId`** (analytics identity, 3 uses). | A random UUID saved on first run, tagged `surface: "desktop"` in PostHog so desktop events don't mix with extension numbers. |
| 14 | **Memory budget.** | Target under 250 MB idle. The ONNX model loads lazily (only on local-embedding index/search); the LSP starts on first use; index workers stay stopped until asked for. Measure every phase, not just at the end. *Measured in Phase 0:* 121 MB idle with no sources. With Confluence connected, 224–418 MB idle and 464–529 MB peak, because the extension's `ChatService.prewarm()` forks the search worker and loads ONNX as soon as the chat view opens (the worker alone is 140–320 MB). So the ONNX model is **not** lazy today. Meeting 250 MB needs either a desktop decision to skip prewarm (first search pays ~1–2 s) or a one-line extension seam; it's a product call. |
| 15 | **Updates.** *(Built 2026-09-24, see apps/desktop/NOTES.md "Auto-update".)* | `tauri-plugin-updater` against GitHub Releases, signed `latest.json`, tags `desktop-vX.Y.Z` (the extension uses `workspaceGPT-v*`, so no collision). `latest.json` lives on a rolling `desktop-latest` release, because `releases/latest` points at extension releases. Downloaded in the background, installed only on restart or quit, after the sidecar has stopped. A beta channel only after stable exists. |
| 16 | **Rust toolchain.** Not installed on this machine; new to the repo. | The Rust side stays deliberately thin (spawn, supervise, window, updater). All product logic stays in TypeScript. CI adds `dtolnay/rust-toolchain`. *(Installed 2026-09-24 via rustup, 1.98.1.)* |
| 17 | **Title-bar actions live outside the webview.** *Found in Phase 0.* New Chat, History and Settings are `contributes.menus["view/title"]` entries drawn by the workbench; without them there is no way into Settings, so no sign-in. | The sidecar reads the same `package.json` menus, evaluates their `when` clauses against the extension's context keys, and the bridge draws them; the Tauri menu mirrors them (⌘N, ⌘Y, ⌘,). A new title-bar entry in the extension shows up in the desktop with no desktop change. |

## Repository layout

```
apps/desktop/
  package.json            # turbo tasks: build, dev, dev:headless, package
  src-tauri/              # Rust shell
    src/main.rs           # window, tray, menu, sidecar supervisor, updater
    tauri.conf.json       # resources: sidecar/, node binary; updater config
    capabilities/         # minimal: dialog, opener, updater, window
  sidecar/
    esbuild.config.mjs    # bundles ../vscode-extensions/src with alias vscode→./vscode-compat
    main.ts               # WS server, token/Origin check, boots the extension's activate()
    vscode-compat/        # workspace, window, commands, env, Uri, fs, secrets, EventEmitter…
    host/                 # lsp client, diagnostics runner, keyring, login-shell PATH
    usage-check.mjs       # CI: vscode.* usage in src/ ⊆ compat coverage
  bridge/desktop-bridge.ts  # window.acquireVsCodeApi over WebSocket
  scripts/fetch-node.mjs    # download + verify the Node 22 binary per target
```

The sidecar boots the real `activate(context)` with a fake
`ExtensionContext` (`globalState`, `secrets`, `globalStorageUri`,
`subscriptions`, `extensionUri`), so the exact provider and handler wiring
the extension uses runs unchanged. `registerWebviewViewProvider` in the compat
module hands the provider a `Webview` whose `postMessage` and
`onDidReceiveMessage` are the WebSocket.

## Phases

Every phase ends with: extension `pnpm build && pnpm check-types` green and
the extension smoke test unchanged (the desktop work can't touch
extension source, so this should be automatic; it's there to prove it).

**Phase 0 — Headless spike (3–4 days).** No Tauri yet.
- `apps/desktop/sidecar` with the compat module stubbed to throw, and
  `usage-check.mjs`.
- Boot `activate()` under plain Node, serve the existing webview build plus
  the bridge on localhost, open it in Chrome and Safari.
- Implement compat APIs until one remote-mode question with a `search_docs`
  tool call and cited answer works end to end.
- **Exit:** a grounded answer in the browser; a list of every compat API hit;
  measured idle and peak RSS.

**Phase 1 — Tauri shell (3–4 days).**
- Install Rust, `pnpm create tauri-app`, sidecar supervisor with the Job
  Object / process group, token injection, folder picker, window-state
  persistence, tray and menu.
- **Exit:** `pnpm --filter desktop dev` opens a native window running the
  Phase 0 flow; quitting leaves no processes behind (checked with `ps`).

**Phase 2 — Agent tool parity (1.5–2 weeks).**
- ripgrep and `fs` for codebase tools.
- `typescript-language-server` client for definition/references.
- tsc/eslint diagnostics runner.
- Keyring secrets, login-shell PATH.
- React diff panel wired to the write gate (replacing hunk lens).
- **Exit:** the agent eval suite (`packages/agent-evals`) runs against the
  desktop sidecar and scores within noise of the extension. This is the
  real acceptance test; "it launches" isn't one.

**Phase 3 — Packaging and release (1 week).**
- `fetch-node.mjs`, pruned native `node_modules`, ad-hoc signing every executable, `install.sh`,
  per-target DMG/NSIS/AppImage, updater plus signed manifest,
  `desktop-publish.yml`.
- **Exit:** a clean macOS machine (no Node, no Homebrew) installs via `install.sh`,
  signs in, connects Confluence, indexes, and gets a grounded answer; an
  update from vN to vN+1 applies.

**Phase 4 — Desktop-only value (after MVP, ordered by value).**
1. Several workspaces in one window.
2. Global hotkey quick-ask.
3. Scheduled agent runs with native notifications.
4. "Import from VS Code" (settings, indexes, chat history — copied once).
5. Bun sidecar re-evaluation.
6. Replace compat shims with real `host.*` seams, one at a time.

Rough total to a shippable macOS MVP: **4–5 weeks**, one person.
Windows/Linux adds about a week of platform testing (Job Objects, WebView2,
NSIS file locks, WebKitGTK).

## Non-goals for MVP

- No changes to `apps/vscode-extensions/src` (compat module only).
- No Ollama-first onboarding (remote mode is the default; local LLM stays an
  advanced setting, as it is in the extension).
- No Chrome-extension share flows (parked).
- No embedded code editor (no Monaco). The desktop app is chat + diff review;
  "open in editor" hands off to the user's editor.
- No Bun, no `@cline/sdk`, no DeepSeek Harness dependency.

## Open questions

1. **Who is the desktop user?** If most target users already live in VS Code
   or Cursor, the extension (plus an Open VSX listing for Cursor/Antigravity)
   may be enough, and this plan's 4–5 weeks is better spent on the agent.
   Worth confirming with the PostHog numbers first — though real usage is
   currently single-digit.
2. **Codebase RAG** is dormant. The desktop inherits whatever the
   extension does; this plan doesn't revive it.
3. **Linux WebKitGTK** quality varies by distro. We could ship Linux as
   "headless mode in your browser" instead of a native app.
