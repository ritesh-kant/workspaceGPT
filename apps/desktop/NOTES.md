# WorkspaceGPT Desktop — build notes

Phase 0 (headless spike) and Phase 1 (Tauri shell) of `docs/design/desktop.md`,
built 2026-09-24 on branch `desktop/phase-0`. Everything lives in
`apps/desktop/`; `apps/vscode-extensions/src` and `webview/src` are untouched.

## Layout

```
apps/desktop/
  sidecar/
    main.ts               boots the real activate(), serves the page, shutdown + watchdog
    esbuild.config.mjs    bundles extension host src with `vscode` → vscode-compat
    usage-check.mjs       vscode.* usage in the extension ⊆ compat coverage (exit 1 on drift)
    vscode-compat/        the `vscode` module: workspace, window, commands, env, languages, extensions, types
    host/                 ExtensionContext, JSON stores, keychain secrets, loopback server,
                          view surfaces, title actions, login-shell PATH, opener, process reaper,
                          worker trace, posthog shim
  bridge/                 shell.html/ts/css (the app page: sidebar + header + two view iframes),
                          desktop-bridge.ts (acquireVsCodeApi over WebSocket per view, dialogs),
                          theme.css (desktop palette → --vscode-*), skin.css (desktop-only view restyle)
  scripts/                dev-headless, dev-tauri, seed-from-vscode, measure-rss, webkit-probe.swift
  src-tauri/              Rust shell: window, menu, tray, folder picker, sidecar supervisor
```

## Phase 0 — result

**Exit criteria met.** Under plain Node, the unchanged extension host code
activated, the unchanged webview build ran in Chrome and in WebKit, a remote-mode
(glm via the Worker) question produced `search_docs` tool calls, and the answer
streamed back with Confluence citations.

| Run | Node | Question | Result |
|---|---|---|---|
| 1 | 24.13.1 | release process | stalled in first model call (see findings) |
| 2 | 24.13.1 | (resume of run 1) | stalled in first model call |
| 3 | 20.18.1 | release process | answered from pre-retrieved context, 10 citations, 22.6 s |
| 3b | 20.18.1 | follow-up "use search_docs … hotfixes" | 2× `search_docs` + answer, 72.6 s |
| 5 | 24.13.1 | "use search_docs … feature flags" | 2× `search_docs` + answer, 87.3 s |
| 6 | 24.13.1 | "use search_docs … STG access / prod approvals" | 3× `search_docs` + answer, 84.3 s |

The `search_docs` path, as traced (`WGPT_DESKTOP_TRACE_WORKERS=1`):
`modelWorker → tool_request{search_docs} → chatService.executeCodebaseTool →
searchKnowledge → forked searchProcess.js (ONNX) → tool_response (12 KB) → model → chunk → done`.

### Memory (RSS, sidecar + its child processes, `scripts/measure-rss.mjs`)

| State | Total | Sidecar (host + model worker thread) | Confluence search worker (forked, ONNX) |
|---|---|---|---|
| Fresh profile, idle (no sources) | **121 MB** | 121 MB | — |
| Seeded profile, idle at 30 s (run 1) | **224 MB** | 83 MB | 140 MB |
| Seeded profile, idle at 45 s (run 6) | **418 MB** | 101 MB | 317 MB |
| Peak, startup (search worker loading ONNX) | **464–529 MB** | 92–106 MB | 372 MB |
| Peak during a 3-tool grounded answer (run 6) | **484 MB** | 160 MB | ~320 MB |

The plan's "under 250 MB idle" holds only without a connected, indexed source.
With Confluence connected, the extension's own `ChatService.prewarm()` forks
the search worker and loads the ONNX model as soon as the chat view opens, so
the model is not lazy. The worker's RSS then drifts between ~140 and ~320 MB
as macOS compresses idle pages.

### Compat APIs hit at runtime (grounded runs + sign-in + fresh boot)

`commands.registerCommand` (38), `workspace.fs.*` (readFile 13, readDirectory 8,
writeFile 4), `workspace.workspaceFolders` (20), `commands.executeCommand` (14:
`setContext` 10, `workspacegpt.newChat`, `workspacegpt.settings`,
`workbench.view.extension.workspacegpt-sidebar`), `extensions.getExtension` (8),
`window.registerWebviewViewProvider` (4), `window.createOutputChannel`,
`window.createStatusBarItem` (inert), `window.showErrorMessage`,
`languages.registerCodeLensProvider` (inert), `workspace.onDidChangeTextDocument`,
`workspace.getConfiguration(workspacegpt.checkForUpdates)`, `env.appName`,
`env.machineId`, `env.openExternal` (sign-in). Plus the ExtensionContext:
`globalState`, `secrets` (keychain), `globalStorageUri`, `subscriptions`,
`extensionUri`, `asAbsolutePath`, `extensionMode`, `extension`.

**No NotSupportedInDesktop was thrown in any run.** `logs/compat-hits.json` in the
data dir has the live list (`kill -USR2 <sidecar pid>` rewrites it; it is also
written at shutdown).

### Static coverage (`node sidecar/usage-check.mjs`)

54 `vscode.*` value chains in the extension: 50 implemented, 3 NotSupported,
1 absent by design; 8 literal command ids, 0 missing. Full table:
`node sidecar/usage-check.mjs --markdown`.

### NotSupported / inert — what each one breaks

| API | Desktop behaviour | What breaks |
|---|---|---|
| `window.createWebviewPanel` | throws | "Open chat in editor" (hidden from the desktop toolbar: the window is already full-size) |
| `vscode.McpStdioServerDefinition` / `vscode.lm` | `lm` is `undefined` | Copilot MCP-server registration is skipped (VS Code-only feature) |
| command `vscode.executeFormatDocumentProvider` | throws | only reached if a user turns on `editor.formatOnSave` in the desktop settings; the error is caught and logged |
| command `workbench.extensions.installExtension` | throws | the extension's update prompt "Install" button (desktop uses its own updater, Phase 3) |
| `languages.registerCodeLensProvider` | inert | agent hunk keep/revert lenses never render (no editor) |
| `window.createStatusBarItem` | inert | MCP status-bar button has nowhere to show |
| `window.tabGroups`, `workbench.action.*` layout commands | inert | none — VS Code layout choreography with nothing to act on |
| `window.showTextDocument` | hands off to `$WGPT_EDITOR`, `code -g`, `cursor -g`, else the OS default app | opening a cited file opens the user's editor, not an in-app view |
| `openExternal` | http/https/mailto only | any other scheme is refused and logged |

## Phase 2 — language service (built 2026-09-24)

`host/languageService.ts` runs `typescript-language-server` (5.3.0, Node ≥ 20)
as a child over stdio and fills `runtime.languageService`. The compat module
turns its answers into `vscode.*` types, so the extension's own
`find_symbol`, `go_to_definition`, `find_references` and `get_diagnostics`
run unchanged. The workspace's own `typescript` is used when it has one;
the desktop's `typescript` dependency is the fallback.

- **Which files it knows** follows VS Code: whatever the extension opens with
  `openTextDocument` or writes through `applyEdit`. Edited files stay open for
  the session, read-only ones in a 20-file LRU.
- **Diagnostics never say "0 problems" for an unchecked file.** Right after an
  edit, or when a tracked file changed on disk behind our back (mtime check
  on every read), `getDiagnostics` throws "still being computed … call
  get_diagnostics again", which the model sees as the tool's error. After
  45 s it says the server may be stuck and points at `run_checks`.
- **`find_symbol` searches every loaded project**, like VS Code's default
  `typescript.workspaceSymbols.scope: allOpenProjects`: `navto` is sent
  without a file through `typescript.tsserverRequest`. The server's own
  `workspace/symbol` passes the most recently used file, which limits the search to
  that one project (it returned 0 hits for `ChatService` here). Projects are
  loaded by opening one source file per `tsconfig.json` (depth 4, up to 8),
  then waiting for their first diagnostics, since asking before a project
  finishes loading also returns `[]`.
- **JS/TS only.** Other languages have no provider, as in a VS Code without
  their extension: lookups return nothing and the tool tells the model to use
  text search. No ESLint diagnostics (VS Code gets those from the ESLint
  extension); `run_checks` / auto-verify still run the linter.
- **Memory** (only the sidecar's own child processes; an earlier "~880 MB"
  also counted the IDE's tsservers running on the same machine). Before, on
  this repo after one definition lookup: ~890 MB = semantic tsserver 440 +
  syntax tsserver 250 + typingsInstaller 100 + the language server 75.
  The desktop now turns off the syntax server (it keeps an editor
  responsive while typing; there is no editor), automatic type acquisition
  (it downloads @types from npm) and package.json auto-imports (a hidden
  project of every dependency, for completions only):

  | After | before | now |
  |---|---|---|
  | go_to_definition (extension project) | ~890 MB | **~500 MB** |
  | find_symbol (extension + webview projects) | ~990 MB | **~680 MB** |
  | 5 min with no calls | ~890 MB until 10 min | **0 MB** |

  What remains is the loaded TypeScript program, which VS Code holds too.
  The server starts on first use and stops after 5 min idle
  (`WGPT_DESKTOP_LSP_IDLE_MS` overrides); a restart costs ~1.5–2.5 s on the
  next lookup. The 250 MB idle target holds; during an agent run that uses
  code intelligence it does not, by design.
- `node scripts/lsp-smoke.mjs [<repo> <symbol>]`: 11 checks on a throwaway
  project (+1 on a real repo) through the extension's real tool functions.
  All pass; cold `find_symbol` 0.5–0.9 s on the fixture, 2–6 s on
  apps/vscode-extensions.

## Phase 2 — diff review panel (built 2026-09-24)

`vscode.diff` opens `host/diffPanel.ts`: a full-pane review drawn by the
chat frame's bridge over the conversation, replacing VS Code's diff editor
and the hunk CodeLenses (`agentHunkLens.ts`), which have nowhere to render
here. Hunks come from the extension's own `computeHunks`; every button runs
the command the lens would have run (`workspacegpt.agent.keepHunk`,
`revertHunk`, `keepAllHunks`, `revertAllHunks`), then both sides are re-read
and the panel redraws. Keep/Revert only appear for agent diffs (left side is
the `workspacegpt-original` scheme); the page can act only on files the host
opened a diff for. Open in editor hands off to the user's editor; Escape or
Close dismisses it.

Verified in the browser pane with `WGPT_DESKTOP_TEST_DIFF` and a hand edit
(one changed line, one deletion, one addition), sent through the Files
Changed bar's own `open-diff-in-editor` message: 3 hunks with correct line
numbers → Revert (deletion restored on disk) → Keep (folded into the
baseline) → Revert all → "No changes left", and the file equalled the
original plus exactly the kept hunk. Dark and light theme, 375 px wide with no
horizontal page scroll.

Not done: a live refresh when the agent writes the file while the panel is
open (the next button press re-reads it), and no side-by-side view.

## Phase 3 — packaging (started 2026-09-24, macOS)

```
pnpm --filter desktop release                      # this Mac's target: stage + tauri build + checks
node scripts/build-release.mjs --target darwin-x64 # the other Mac
node scripts/stage-runtime.mjs [--skip-build]      # just dist/runtime/
```

- **`scripts/fetch-node.mjs`** downloads the pinned Node (**v24.21.0**, Active
  LTS) for a target from nodejs.org and checks it against `SHASUMS256.txt`.
  Cached in `.cache/node/`.
- **`scripts/stage-runtime.mjs`** builds the extension with `VSCODE_TARGET`
  (its own onnxruntime/ripgrep pruning) and the sidecar with
  `NODE_ENV=production` (analytics on), then assembles `dist/runtime/`:
  `node`, `sidecar/` (main.js, workers, models, mcp-server.js, pruned native
  `node_modules` + keyring/typescript/typescript-language-server),
  `bridge/`, `extension/` (package.json, resources, webview/dist,
  dist/mcp-server.js), `manifest.json`. Source maps are dropped. darwin-arm64:
  717 files, **376 MB** (models 186, node 128, typescript 24, onnxruntime 20).
- **Signing:** every Mach-O file but `node` is ad-hoc signed (4: rg, the
  keyring addon, onnxruntime's binding + dylib). `node` keeps Node's
  Developer ID signature (team HX7739G8FX); its hardened-runtime entitlements
  include `disable-library-validation`, which is what lets it load
  ad-hoc-signed addons. Tauri ad-hoc signs the shell and the bundle, and
  `codesign --verify --deep --strict` passes on the `.app`.
- **Shell:** `sidecar.rs` finds `runtime/` in the bundle's resources (macOS
  `Contents/Resources/runtime`, Windows next to the exe, Linux
  `../lib/WorkspaceGPT/runtime`) and runs `runtime/node runtime/sidecar/main.js`;
  `WGPT_NODE` / `WGPT_SIDECAR_MAIN` still win (dev). `main.ts` uses
  `../extension` when it exists. `tauri.release.conf.json` adds the resource,
  so `tauri dev` needs no staged runtime.
- **`scripts/build-release.mjs`** runs the stage, `tauri build --config
  src-tauri/tauri.release.conf.json --target <triple> --bundles app,dmg`, and
  checks the bundle. darwin-arm64: DMG **195 MB**, updater `.app.tar.gz` 193 MB
  + `.sig`. Uses `TAURI_SIGNING_PRIVATE_KEY`, else the local key.
- **`install.sh`** (published on the rolling `desktop-latest` release): reads
  the updater's `latest.json`, downloads this Mac's `.app.tar.gz` with curl
  (no quarantine flag), checks it against the release's `SHA256SUMS.txt`,
  installs to /Applications (or ~/Applications), verifies the signature.
- **`.github/workflows/desktop-publish.yml`**: tag `desktop-vX.Y.Z` → both Mac
  targets built on one macos-14 runner (x64 cross-compiles), release
  `desktop-vX.Y.Z` with DMGs, updater bundles, `.sig`s and `SHA256SUMS.txt`
  (`--latest=false`, so the repo's Latest stays the extension's), then
  `latest.json` + `install.sh` onto `desktop-latest`. A manual run only builds.
  Needs the `TAURI_SIGNING_PRIVATE_KEY` secret.

**Verified here (arm64):** the staged runtime copied outside the repo and
started with an emptied environment (no node on PATH, no WGPT_* dev vars)
loads onnxruntime-node, the keychain addon, ripgrep and the language server,
and the sidecar activates (2.3 s). The built `.app`, copied elsewhere and
launched the same way, starts its own `Contents/Resources/runtime/node`, the
extension activates (4.4 s), and a quit stops everything with nothing left.
`install.sh` against a local copy of a release: fresh install and
reinstall work and the installed app verifies; a tampered bundle is refused
(checksum) and nothing is installed. darwin-x64 staging: every native binary is
x86_64 and signed correctly, but it was **not run** (no Rosetta here).

**First real releases (2026-09-25).** `desktop-v0.0.1` and `desktop-v0.0.2`
were published by `desktop-publish.yml` once the repo went public (a private
repo's release assets 404 anonymously, so install.sh and the updater need a
public repo). Checked against the public URLs:
- `curl … install.sh | sh` installed 0.0.1 in 29 s (SHA-256 checked, codesign
  verified, no quarantine xattr). Launched with its bundled Node, and both views
  connected in ~1.7 s.
- Updater 0.0.1 → 0.0.2: the first check (30 s after launch) found 0.0.2 in
  `desktop-latest/latest.json` and downloaded 203 MB with a valid signature.
  A normal quit logged "installed v0.0.2". Info.plist and
  `runtime/manifest.json` then read 0.0.2, the signature still verified, and
  no processes were left. On relaunch it polled and found nothing newer.
- Keychain: an item created by 0.0.1's `runtime/node` was read by 0.0.2's
  `runtime/node` with **no prompt**. Node keeps its own Developer ID
  signature (team HX7739G8FX), which doesn't change between our releases.
  Expect a prompt once when `NODE_VERSION` changes.
- The CI-built `.app.tar.gz.sig` files verify against `plugins.updater.pubkey`
  (key id 00da8e104e544963).

**Not done / open:**
- A clean-Mac run (no Node, no Homebrew; ideally an Intel Mac, since x64 was never
  run here) of install → sign in → connect Confluence → index → grounded answer.
- Windows (NSIS) and Linux (AppImage): the scripts know the targets, the
  workflow doesn't build them.

## QA pass (2026-09-25)

Fresh profile, headless sidecar driven in the browser pane, chat against a
local mock OpenAI-compatible server, plus a static review of the shell,
sidecar, bridge and installer. Fixed:

- **MCP promo toast on first launch.** The extension's "Connect MCP" toast
  (it writes the editor's mcp.json) sat over the onboarding card. `main.ts`
  marks `workspacegpt.mcp_welcome_shown` before activate.
- **Local mode with Ollama down showed nothing.** No model list, no error,
  a greyed-out Continue: every models-list failure became "Invalid API Key",
  and that error only rendered inside the API-key box Ollama doesn't have.
  Now "Could not reach <url> — is the server running?", shown for keyless
  providers too.
- **Footer said "Not signed in · Sign in from Settings" in Local mode.** The
  shell now follows `config.mode` (settings load + saves, via a new
  `viewMessage` bridge hook) and shows "Local mode · No account needed".
- **Knowledge "Connect" opened a page with the source switched Off.**
  `prepareToConnect()` turns the source on for Connect clicks (overview,
  greeting line, composer Context menu); plain nav visits don't.
- **Cited files could be executed.** The no-editor fallback was plain `open`,
  which runs `.command`/`.jar`/`.webloc`; now `open -t` (Windows: notepad).
- **Two quick Open Folder picks quit the app** (second restart skipped the
  stop, the new sidecar hit the profile lock). Restarts hold a lock; a quit
  mid-restart waits for it.
- **Questions hung after a page takeover** (superseded socket's close bails):
  open questions are re-sent to the new page.
- **Install path with `#`/`?`** gave a blank view: escaped in asset/icon URLs.
- **Stale profile lock + reused pid** blocked every launch: a pid that started
  after the lock was written is treated as stale (`ps -o lstart`).
- **Diff panel:** a fast second click went by a stale hunk index; all
  file-changing buttons now wait for the redraw. Open in editor no longer
  disables itself for good.
- **Malformed `/view/%E0%A4`** hung the request: now 400.
- **install.sh** verifies the signature before replacing the app and puts the
  previous one back if the copy or the check fails.

Native-app checks (`tauri dev`), each reproduced on the old code first:
- Open Folder race: a temporary env hook fired two restarts 1 s apart while
  the old sidecar was SIGSTOPped for 3 s (a busy sidecar). Old: "giving up …
  already using this profile". Fixed: A then B, one sidecar on B. A quit
  0.5 s into the restart: nothing restarted after it, 0 processes left.
- Question takeover: joined the socket with `WGPT_DESKTOP_DEBUG_TOKEN_FILE`,
  sent `agent-revert-checkpoint`, opened a second tab. Old: the new tab had
  no question. Fixed: it did, and its "Undo" reached the host.
- Open as text: sidecar PATH without code/cursor (minimal PATH + a stand-in
  `$SHELL` for the login probe), cited `setup.command` that touches a marker.
  Old: Terminal ran it. Fixed: TextEdit opened it, no marker.

Not covered: Remote sign-in and real Confluence/ADO/Jira connections (need
accounts); Windows' notepad fallback.

## Findings from Phase 0 (and what was done)

1. **Title-bar actions don't exist outside VS Code.** Settings, History and New
   Chat are `contributes.menus["view/title"]` entries that the workbench draws,
   not buttons in the webview. Without them you can't reach sign-in. Fixed in
   the desktop: `host/titleActions.ts` reads the same `package.json` entries,
   evaluates their `when` clauses against the context keys the extension sets,
   and the bridge draws them top-right. The Tauri menu has them too (⌘N, ⌘Y, ⌘,).
2. **Intermittent model-call stalls (not desktop-specific as far as I can tell).**
   In 2 of 6 runs the first non-streaming tool turn got no response: the ~85 KB
   request was sent, no completion came back, and no credits were metered
   (credits used stayed at 1). The Worker answered a curl of the same shape in
   2.4 s at the same time. The openai SDK, in both a plain and an ESM-bundled
   worker thread, worked on Node 24 and 20. The same Node 24 build then succeeded
   three times. The call goes straight from `modelWorker` to the Worker, with no
   compat code in between. The SDK's 600 s timeout means a stall shows as
   "Thinking…" for up to 10 minutes. Worth checking with `wrangler tail` for
   requests that never finish upstream; the extension would behave the same.
3. **The login-shell PATH probe can take more than 3 s** (nvm and conda in
   `.zshrc`; it timed out once). It now waits up to 8 s on first launch, saves the
   result in `desktop.json`, and later launches use the saved PATH at once and
   refresh it in the background.
4. **A restarted headless sidecar prints a new token.** Pasting the new link into
   the old tab changes only the fragment, so the page doesn't reload. The bridge
   now handles `hashchange`. Under Tauri the shell owns the token, so it survives
   sidecar restarts.
5. **The sign-in callback page says "return to VS Code".** It's the extension's
   copy in `OAuthCallbackServer`. Cosmetic; it would need an extension change,
   so I left it.
6. **A Confluence auto-sync failure toast appears on a seeded profile.** The seed
   copies the index, not the Confluence OAuth tokens, so background sync reports
   "connection expired". `search_docs` needs only the index. A real profile
   connects Confluence inside the desktop.
7. **Analytics are off in dev desktop builds** and on in `NODE_ENV=production`
   builds (`WGPT_DESKTOP_ANALYTICS=1`/`=0` overrides). Every desktop event gets
   `surface: "desktop"` (extension events: `surface: "extension"`), and
   `vscodeVersion` reads `desktop-<version>`. PostHog: the main dashboard breaks
   down by `surface`; "WorkspaceGPT Desktop" filters to `surface = desktop`.
8. **Windows secrets:** Credential Manager caps a blob at 2560 bytes, and the
   ADO MSAL cache is ~32 KB. *Phase 2:* on Windows, values over 1200 UTF-16
   units are split into generation-tagged chunks under a header entry
   (`chunked()` in host/secrets.ts); values that fit, and entries written
   before, are stored/read whole. `node scripts/secrets-chunk-test.mjs` checks
   it against a fake Credential Manager with the real cap (12 checks, any OS;
   `WGPT_DESKTOP_SECRETS_CHUNK=<units>` forces the path in a real run). Not run
   on Windows itself yet.
9. **Lockfile:** adding `ws@8.21.0` deduped puppeteer-core's `ws` 8.18.1 → 8.21.0
   (a patch bump in a dev tool). `@tauri-apps/cli@2.11.5` was added.

## Phase 1 — result

`pnpm --filter desktop dev` builds the sidecar, compiles `src-tauri` (Tauri
2.x, Rust 1.98.1) and opens a native window, 520×860, running the Phase 0 flow.
The sidecar activates in ~40–50 ms using the cached PATH. The window loads
`http://127.0.0.1:<port>/` directly from the sidecar, and the token arrives via
the initialization script.

How the shell is wired (`src-tauri/src/`):
- **Token.** The shell makes 32 random bytes, sends them as the first stdin line
  (`{"type":"hello"}`), and injects them with an initialization script. The
  script only sets the token when `location` is `http://127.0.0.1`. The token
  never appears in argv, env, a URL or a log. It survives sidecar restarts, so
  a restart only changes the port.
- **Supervision.** The sidecar is started with `process_group(0)`. On quit the
  shell sends `{"type":"shutdown"}`, closes stdin, waits 8 s, then `killpg`
  SIGTERM and SIGKILL, and always SIGKILLs any stragglers in the group. An
  unexpected sidecar exit restarts it (at most 3 times a minute, then a dialog)
  and the window navigates to the new port.
- **Signals.** SIGTERM, SIGINT and SIGHUP go through the normal quit path.
- **Menu.** App (About, Settings ⌘,, Hide, Quit), File (New Chat ⌘N, Chat
  History ⌘Y, Open Folder… ⌘O), Edit (without it macOS sends no ⌘C/⌘V/⌘A to the
  webview), View (Reload ⌘R, Full Screen), Window.
- **Tray.** Show, New Chat, Open Folder…, Quit. Closing the window hides it;
  the Dock icon or tray brings it back.
- **Open Folder….** Native picker, then the sidecar restarts with
  `--workspace`, the same way VS Code restarts the extension host on a folder
  change.
- **Navigation.** The window only navigates to its own loopback page; any other
  http(s) link opens in the system browser.
- **Window state.** Persisted with `tauri-plugin-window-state`.
- **No Tauri IPC.** `capabilities/default.json` is empty on purpose.

### Process-cleanup tests (all checked with `ps` afterwards)

| Test | Result |
|---|---|
| `tauri dev` rebuild kills the app | old sidecar + its search worker gone |
| SIGTERM to the app (normal quit path) | `signal 15: quitting` → sidecar `shutting down (shell asked)` → search worker reaped → **0 processes left** |
| **`kill -9` the app mid-run**: model turn in flight, search worker up, and a detached `bash -lc 'sleep 300 & sleep 301; wait'` started through the extension's own `commandTools.executeCommand` (own process group, outside the sidecar's) | sidecar watchdog: `"parent closed stdin"`; `logs/last-shutdown.json` lists the search worker **and** the detached bash group as reaped; **0 processes left** |
| `kill -9` the sidecar only | shell: `exited unexpectedly … restarting` → generation 2 → the window reconnected on the new port with the same token; old search worker gone |

The detached-command case needed `host/processReaper.ts`. `run_command` and
`run_checks` children are spawned `detached` so tree-kill can take down a whole
test runner, which also puts them outside the sidecar's process group, so the
shell's `killpg` alone would have orphaned them.

### Desktop shell UI (after Phase 1)

The window is now a two-pane app rather than the chat panel alone:

- `/` is the shell (`bridge/shell.*`). It frames the extension's **Sessions
  view** (`workspacegpt.sessionsView`, the list VS Code shows when chat is
  maximized) as the sidebar and the **chat view** as the main pane, at
  `/view/<viewType>`, each with its own socket (`?view=`). Both providers are
  resolved in `main.ts`; nothing in the extension changed.
- The shell's own chrome is built from traffic it observes through the framed
  bridges: header title from `sessions-list`, account footer from
  `remote-session-status` / sign-in / sign-out, header buttons from the chat's
  title actions (New Chat → header "+", Settings → footer gear, History only
  when the sidebar is hidden). Clicks go back through the chat's socket, so
  the sidecar still honours only real title actions.
- **All conversations in the sidebar.** VS Code's Sessions list shows only the
  current mode's sessions; the desktop rewrites its `sessions-list` (a
  `ViewSurface.outgoing` hook) to the full `HistoryService` list, and the shell
  tags Chat-mode rows. Opening one already switches the chat to its mode
  (`GET_CHAT_SESSION_RESPONSE`).
- Look: a neutral palette with its own accent (`--wgpt-d-*` in theme.css,
  light and dark), one centred reading column, composer card with the branch
  strip as its header, borderless assistant turns, grey user bubbles; the home
  screen's Recent Chats list is hidden while the sidebar is docked. All of it
  is CSS in `skin.css` keyed on `html[data-wgpt-desktop]`.
- Under 720px wide the sidebar folds away (toggle in the header, floats over
  the chat when opened), so the old 520px window still works.
- Tauri (macOS): 1180×800 default, `TitleBarStyle::Overlay` with the header as
  `data-tauri-drag-region`. That needs IPC, so `capabilities/window-drag.json`
  grants the loopback page exactly `start_dragging` and
  `internal_toggle_maximize`. Checked in the native window: toggle-maximize
  returned ok, `set_title` was refused ("not allowed"). The window-state plugin
  keeps a previously saved window size, so an existing install reopens at its
  old size.
- Checked with `webkit-probe.swift` (now `--height`, `--appearance`, `--run`):
  home, a loaded session, Settings, dark mode, 560px narrow, the overlay
  layout, and opening a Chat-mode session from the sidebar. Dragging the window
  by the header was not driven (no input automation here).

- **Settings is a two-column screen (2026-09-24, Cline-style).** The
  webview's `Settings.tsx` has a second layout, `page`, chosen when
  `isDesktopHost()` (vscode.ts: `html[data-wgpt-desktop]`) is true: a nav
  column on the left and a page on the right: a heading, a one-line
  description, then the page's sections as always-open cards
  (`SettingsLayoutContext` in `settings/SectionShell.tsx`). Nav: General ·
  Knowledge with every source nested beneath it (Confluence, Azure DevOps,
  Jira, Web Search; status dot per row) · Deployment pipeline [Beta].
  General holds Mode (two descriptive cards on the desktop, `ModeSelector`),
  Account or Model, and Reset together — as separate pages each was a heading
  over one control ("shallow", user). **Knowledge** is an overview in the
  shape of Cursor's Integrations page (icon · name · description · status ·
  action per row, grouped "Your organisation" / "Beyond your organisation"),
  rendered from the `KNOWLEDGE_SOURCES` registry in
  `settings/knowledgeSources.tsx`; a new source is one entry there plus its
  settings component. The user was explicit that the sources are the product,
  not optional add-ons: hence "Knowledge" not "Integrations", every source
  always listed, "Not connected · Connect" rather than "Off · Set up", and
  Web Search set apart as the supplement. No MCP Server page on the desktop
  (its installer writes the host editor's mcp.json; there is no editor). A
  card titled like its page keeps only its status row; a switched-off
  source gets a "Turn on … to connect" line. The last page is remembered
  (`workspacegpt.settingsPage`). VS
  Code keeps the stacked collapsible column. The shell adds
  `.app.settings-open` while the panel is up (shell.ts `checkPanel`) and hides
  the sessions sidebar and header title, so the nav takes the sidebar's place
  and the window stays two columns; `skin.css` gives it the sidebar surface.
  Under 600px the nav becomes a chip row. Checked in the browser pane against
  a headless sidecar on a scratch profile: every page, the reset dialog, back
  (sidebar returns), light and dark, 1180px and 560px.

- **Knowledge line in the greeting (2026-09-24).** On the desktop, Work
  mode, the greeting's subtitle ("knows your whole org…") is replaced by the
  evidence: "Knows your org through ● Confluence ● Azure DevOps · synced 2h
  ago ○ Jira · Connect" (`components/KnowledgeLine.tsx`, rendered by
  `HomeGreeting` when given `onOpenSettings`). Organisation sources only —
  Web Search is a supplement and stays in Settings. Freshness appears once,
  for the most recently synced source. With nothing connected the lead reads
  "Connect your knowledge:" and the names take the accent. Every item
  deep-links into Settings: the ui store gained `openSettings(page?)` /
  `settingsPage`, `Settings.tsx` lands on the requested page once, and the
  host's `show-settings` message accepts an optional `page`. A first version
  was a separate "Knowledge" section with bordered chips between the greeting
  and Your work; the user found it crowded, hence the fold. Checked in the
  browser pane on a scratch profile: line → source page, light and dark. The
  empty state was not exercised (the profile has sources connected).

- **One judgement per source (2026-09-24).** `KNOWLEDGE_SOURCES[i].status()`
  in `settings/knowledgeSources.tsx` is now the single place a source's state
  is decided — connect → choose scope → first sync/index → ready, with
  "Syncing… N%" / "Indexing… N%" (progress), "Paused · Resume the sync",
  "Indexing unfinished · Finish the sync", "Not synced yet · Start the sync".
  `ready` means answers can be grounded in it; a re-sync of an indexed source
  stays ready. The Knowledge page, the greeting line and the composer's
  Context menu all read it (App.tsx's own `knowledgeContextOption` is gone),
  so the greeting no longer calls a source connected while the menu calls its
  indexing unfinished. In the Context menu a source that can't be picked is
  still listed, its subtitle ends in the step to take, and clicking the row
  opens that source's Settings page (`DropdownOption.disabledAction`,
  keyboard-reachable); a "Manage knowledge ›" footer (`SearchableDropdown`
  `footer`) opens the Knowledge overview. Checked in the browser pane on a
  scratch profile: row → Azure DevOps page, footer → Knowledge, and the
  greeting's empty state ("Connect your knowledge:") now seen for real.

- **Found in the native window: blank chat + settings overwrite.** The chat
  asks for its settings (`get-global-state`) while its bundle is still
  evaluating, but only attaches the listener that handles the answer in
  React's first effect, which then posts `chat-webview-ready`. Over the
  loopback socket the answer could land in that gap and be dropped. The chat
  then sat on its empty `app-loading` screen, and the next host messages made
  its un-hydrated store persist *default* settings over the real ones (seen in
  a test profile: mode → local, onboarding reset). VS Code's slower channel
  hides the race; the extension has the same shape. Fix, bridge-only: the chat
  view's incoming messages are held until the page posts `chat-webview-ready`
  (15 s fallback). Verified 3/3 in the native window, signed in. The bridge
  now also forwards page errors to the sidecar log (`[page <view>] …`).

- **Second pass (user report: onboarding text invisible, "test everything").**
  - First-run setup is now a startup panel: while the chat shows its
    onboarding, the shell hides its sidebar and header (it watches the chat's
    `#root` children), and the skin draws the steps as a centred card. The app
    appears after Finish (verified: Local → Skip → Finish restores sidebar).
  - Invisible text had one root cause: the webview's `:where(button)` gives
    every button white text, and components that restyle only the background
    (the onboarding mode cards) kept it. `scripts/contrast-audit.js` now
    checks every visible text node in the shell and both frames (composited
    colour vs effective background, flags < 3:1); run through
    `webkit-probe.swift --eval`. Swept home (both modes), six conversations
    with timelines expanded, Settings with every section open, onboarding
    steps 1–3, History, the context/agent/mode menus, the @-mention picker,
    sidebar search and the startup toast, light and dark: all clear after the
    skin fixes (mode cards, timeline summaries, dropdown arrows, next-sync
    time, disabled dropdown rows, sidebar group headers).
  - Header names the full-pane screen (Settings / History / Releases).
  - **One sidecar per profile** (`host/profileLock.ts`): two sidecars on one
    data dir each rewrite the whole state.json and overwrite each other — this
    is how the user's settings were reset a second time (a stale headless
    instance). A second sidecar now exits 75 with `@@WGPT_PROFILE_IN_USE@@`,
    and the shell shows why instead of restarting it. A dead owner's lock is
    taken over (tested after kill -9). The native app is also single-instance
    (tauri-plugin-single-instance): a second launch focuses the first window
    (tested: exits at once).
  - Questions the extension asks before a window connects (the startup
    "Confluence connection expired — Reconnect?") waited for nothing and were
    dropped; they now wait up to 30 s for the page.
  - Functional run, signed in, on a copy of the real profile: grounded answer
    with Confluence D2C citations (16 credits); citation click goes through
    `openExternal` and the chat stays; search, New session, delete (file
    removed), sidebar collapse/expand (History + Recent Chats come back),
    Chat/Work switch all behave.
  - The "stall" is the model: one non-streaming call took **187 s** for 3,247
    completion tokens (the UI keeps showing "Thinking… 1m58s"). Same in VS
    Code; nothing desktop-side to fix — streaming the first call would make
    it feel alive.

- **Found while the user ran headless alongside test runs (reported by a review session):**
  - `dev:headless` said nothing when the sidecar died by signal (pnpm printed
    only "Exit status 1"). It now prints `[desktop] sidecar killed by SIGKILL`
    and exits 128+n, and names exit 75 as "profile already in use".
  - A headless sidecar outlived a launcher that died without signalling it
    (no stdin watchdog outside the shell). It now polls its parent and shuts
    down, reaping its search worker and releasing the profile lock, when it
    is reparented (tested: launcher kill -9 → sidecar gone in 2 s).
    `--detached` opts out, for deliberate background runs.
  - Two instances on the default profile: the profile lock now stops the
    second with a plain-language message in the terminal.
  - **Don't rebuild the extension while a desktop sidecar runs.** Its build
    copies native modules (onnxruntime, sharp) over the loaded files in place,
    and macOS kills a process whose loaded code is rewritten (SIGKILL, no
    shutdown log) — the likeliest cause of the user's silent headless death.
    The desktop build now leaves correct `dist/sidecar/*` links alone instead
    of re-creating them under a running sidecar.
  - All automated runs in this pass used scratch profiles
    (`WGPT_DESKTOP_DATA_DIR` / `--data-dir`); the default profile was only
    touched to restore it with `seed:from-vscode --force` after the reset.

- **Notifications (2026-09-24).** The user is told when a run needs them or
  finished. `sidecar/host/notifier.ts` watches the chat's own traffic — no
  extension edit: `agent-write-review` → "Approval needed" (the run is
  blocked on the card; body = the prompt + the command or change),
  `receive-message-done` → "Done · N files changed" (count from
  `agent-turn-summary`), `error-chat` → "Run stopped with an error", and any
  compat `window.show*` question → "WorkspaceGPT needs an answer". A turn the
  user stopped gets nothing, and the DONE after an ERROR_CHAT is dropped (one
  notice per ending). The label is the user's own message, taken from
  `send-message`; which session is on screen comes from `session-changed`.
  The sidecar prints `@@WGPT_NOTIFY@@ {kind,title,body,sessionId,visible}`;
  `src-tauri/src/notify.rs` skips it when the window is focused and showing
  that session, otherwise posts a native notification
  (tauri-plugin-notification 2.4.0) and bumps the Dock badge, which clears when
  the window takes focus. On/off: app menu → "Notify When a Run Needs Me or
  Finishes", saved in `<app config dir>/notifications.json` (default on).
  Headless only logs `[desktop] notify (…)`. Checked: the watcher against a
  scripted message sequence (approval ×2, done with files, error+done, stopped
  run, sessionless question) and `cargo check`. Not checked: a banner in the
  native window (no input automation here). Under `tauri dev` macOS shows
  banners as coming from Terminal (the plugin's dev behaviour); the bundled
  app shows its own name. Clicking a banner brings the app forward but does
  not open that session, and does not un-hide a closed window.

### Not verified here

- **Clicking in the native window** (menu items, Open Folder…, tray, typing a
  question) was not driven by me. `screencapture` has no Screen Recording
  permission in this session, and AppleScript UI scripting would have needed an
  Automation permission prompt, which I cancelled. The native window's React app
  was confirmed live through the sidecar (11 messages each way on load), and
  WKWebView rendering was confirmed with `scripts/webkit-probe.swift`. See the
  manual checklist in the hand-off.
- **Windows:** the Job Object is in (see *Windows* below). **Linux:** not run.

### Dev hooks (all opt-in env vars, all read by the sidecar)

| Var | Effect |
|---|---|
| `WGPT_DESKTOP_DATA_DIR` | profile directory (default `~/Library/Application Support/WorkspaceGPT Desktop`) |
| `WGPT_DESKTOP_SECRETS=memory` | in-memory secrets instead of the keychain |
| `WGPT_DESKTOP_NO_BROWSER=1` | `openExternal` logs the URL instead of opening a browser |
| `WGPT_DESKTOP_TRACE_WORKERS=1` | logs every worker_thread message (type and size only) |
| `WGPT_DESKTOP_ANALYTICS=1` / `=0` | force PostHog on / off (default: on in `NODE_ENV=production` builds, off in dev); events are tagged `surface: desktop`, extension events `surface: extension` |
| `WGPT_DESKTOP_DEBUG_TOKEN_FILE=<path>` | writes the socket link (0600) so a browser tab can join a Tauri-run sidecar |
| `WGPT_DESKTOP_LSP_IDLE_MS=<ms>` | how long the TypeScript server may sit unused before it is stopped (default 5 min) |
| `WGPT_DESKTOP_TEST_DIFF=<file>` | records `<file>`'s current text as the agent's pre-edit original, so a hand edit shows in the files-changed review (diff-panel test) |
| `WGPT_DESKTOP_TEST_COMMAND=<cmd>` | starts `<cmd>` through `commandTools.executeCommand` at startup (orphan test) |
| `WGPT_EDITOR=<cmd>` | editor used for "open file" hand-off (`<cmd> file:line`) |

## Auto-update (built 2026-09-24)

`src-tauri/src/updater.rs` uses `tauri-plugin-updater`. The whole app is
one unit: the Tauri shell, the sidecar and (from Phase 3) the bundled Node
live inside the `.app`, so they always update together. The extension's own
Open VSX check is switched off in the desktop build
(`workspacegpt.checkForUpdates` defaults to `false` in
`vscode-compat/workspace.ts`), because it would announce extension versions
and its Install button can't work here.

**How it works**

1. **Check.** 30 s after launch, then every 6 h, and on *WorkspaceGPT →
   Check for Updates…*, the shell fetches `latest.json` from
   `plugins.updater.endpoints` in `tauri.conf.json`. Release builds only: in
   a dev build the menu item says updates are off.
2. **Download in the background.** When the manifest's version is higher
   than the running one, the shell downloads the platform bundle (the
   `.app.tar.gz` on macOS) into memory. The plugin then checks its minisign
   signature against `plugins.updater.pubkey`. A mismatch is rejected and
   nothing is kept.
3. **Tell the user once per version.** The shell sends
   `{"type":"update-ready","version":…}` to the sidecar over stdin. The
   sidecar shows it through the same notice UI the extension's own messages
   use (chat pane, with *Restart Now* and *Later* buttons). The menu item
   changes to *Restart to Update to vX…*.
4. **Install only in the exit path.** *Restart Now* (the notice prints
   `@@WGPT_UPDATE_RESTART@@` on stdout, or the menu dialog) calls
   `request_restart()`. So do nothing and the next ordinary quit installs it.
   Either way `RunEvent::Exit` first runs `Supervisor::shutdown`, which
   stops the sidecar, its process group and detached command children. Then
   `install_on_exit` swaps the bundle in place. A background update never
   interrupts an agent run, because only the user's own restart or quit
   triggers the install. If the install fails, the old version keeps
   working and the next launch downloads it again.
5. If a newer release appears while one is waiting, the newer one replaces it.

**Publishing a release** (not automated yet; `desktop-publish.yml` is Phase 3):

- Tag `desktop-vX.Y.Z` and set `version` in `tauri.conf.json` to match.
  The updater compares against that field.
- Build with `TAURI_SIGNING_PRIVATE_KEY` (the path or the key text) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`.
  `bundle.createUpdaterArtifacts` then writes `<bundle>.sig` next to each
  bundle.
- `node scripts/updater-manifest.mjs --version X.Y.Z --base-url
  https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-vX.Y.Z
  darwin-aarch64=…/WorkspaceGPT.app.tar.gz [darwin-x86_64=… windows-x86_64=…]`
- Upload the bundles and `.sig` files to the `desktop-vX.Y.Z` release. Upload
  `latest.json` to the **rolling `desktop-latest` release** with
  `gh release upload desktop-latest latest.json --clobber`. That is the fixed
  URL installed apps poll. `releases/latest/download/…` can't be used: the
  repo's "latest" release is whichever extension `workspaceGPT-v*` release
  came last.
- **Signing key:** the private key is at
  `~/.tauri/workspacegpt-desktop-updater.key` (no password; pubkey in
  `tauri.conf.json`). Back it up and add it as the `TAURI_SIGNING_PRIVATE_KEY`
  repo secret. If it is lost, every installed copy stops accepting updates
  and users must reinstall by hand. Rotating it before the first public
  release is free.

**Verified on this Mac (arm64), scratch profile, local server.** v0.0.1 was
built with a `--config` override pointing the endpoint at
`http://127.0.0.1:8799/latest.json` with `dangerousInsecureTransportProtocol`.
The shipped config stays https-only and has no env override. v0.0.2 was
built with `--config '{"version":"0.0.2",…}'` and served by
`python3 -m http.server`.
- *Restart Now* from the chat-pane notice: the sidecar stopped, the updater
  logged "installing v0.0.2" then "installed", and the app relaunched from the
  same path. `Info.plist` reads 0.0.2, ad-hoc signature intact, no quarantine
  xattr. The relaunched v0.0.2 polled, found nothing newer and downloaded
  nothing.
- *Quit with an update waiting* (SIGTERM, which takes the normal quit path):
  installed on the way out, not relaunched, no processes left.
- *Tampered bundle* (one byte appended): "The signature verification failed".
  The app stayed on 0.0.1.

**Not verified / open:**
- Windows (NSIS, which exits the app to run its installer; Restart Now
  relaunches, a quit doesn't) and Linux AppImage were not run.
- ~~A release build still finds the sidecar and Node through dev paths~~ (fixed in Phase 3: the runtime is bundled)
  (`sidecar_entry()`, `WGPT_NODE`). Until Phase 3 bundles them, an update
  replaces only the shell. The mechanism is the same once they're inside the
  `.app`.
- ~~Keychain prompts after each update~~: checked 2026-09-25 through the
  real 0.0.1 → 0.0.2 update, and there was no prompt. The keychain client is
  the bundled `runtime/node`, which keeps Node's own Developer ID signature;
  the ad-hoc-signed shell isn't what the ACL names. See the Phase 3 section.
- An app installed in `/Applications` by an admin, then run by a non-admin
  user, can't replace itself. The plugin asks for elevation. Not tried.

## Windows (built 2026-09-25, x64, no code signing)

- **Process cleanup.** `src-tauri/src/sidecar.rs` puts the sidecar in a Job
  Object with `KILL_ON_JOB_CLOSE`. The sidecar and everything it starts die
  when the shell's handle closes: on reap, on stop, or when the shell itself
  dies. `CREATE_NO_WINDOW` keeps node.exe from opening a console. The
  extension already skips `detached` on Windows (`commandTools.ts`), so
  agent commands stay windowless.
- **Browsers and editors** open through `explorer.exe` (`host/opener.ts`),
  the editor via `vscode://file/…` / `cursor://file/…`. The Windows shell
  starts them, so a browser or editor that WorkspaceGPT cold-started isn't in
  our job and doesn't close when we quit. `WGPT_EDITOR` and the notepad
  fallback still start inside the job.
- **Install without a certificate.** `install.ps1` (`irm …/install.ps1 | iex`)
  reads latest.json, checks the installer against SHA256SUMS.txt, and runs the
  NSIS installer silently, per user (`%LOCALAPPDATA%\WorkspaceGPT`, no admin).
  Invoke-WebRequest writes no Zone.Identifier, so SmartScreen doesn't stop the
  unsigned installer. A browser-downloaded `-setup.exe` still gets "Windows
  protected your PC" (More info → Run anyway). Smart App Control, where it is
  on, may block unsigned apps regardless.
- **Updates:** NSIS in passive mode; the `-setup.exe` is the updater bundle
  (tauri signs it: `-setup.exe.sig`), under `windows-x86_64` in latest.json.
- **CI** (windows-latest, run 36118385389): the build installs via install.ps1
  from a local http.server, then:
  - `scripts/smoke-installed.mjs` passes 6/6: bundled node.exe serves the page;
    a run_command child starts; after `taskkill /F` of the shell alone,
    nothing from the install dir or the command survives.
  - `secrets-chunk-test.mjs` passes, including a live Credential Manager round
    trip: a 32 KB value stored as 28 entries under the 1280-unit cap.
- **Not verified yet:** a hand run on a real Windows PC (window, WebView2
  rendering, sign-in, a grounded answer), and an in-app update from one
  Windows release to the next (first possible from 0.0.3 → 0.0.4).
