# WorkspaceGPT Desktop

The WorkspaceGPT agent as a standalone app for macOS and Windows, with no editor needed. A
Tauri (Rust) shell starts a Node sidecar. The sidecar runs the VS Code
extension's host code **unmodified**, because esbuild swaps the `vscode` module
for [`sidecar/vscode-compat`](sidecar/vscode-compat). The webviews talk to it
over a loopback WebSocket.

- Design and phases: [docs/design/desktop.md](../../docs/design/desktop.md)
- Findings, measurements, compat coverage, dev hooks: [NOTES.md](NOTES.md)

## Install (users)

```bash
# macOS
curl -fsSL https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.sh | sh
```

```powershell
# Windows (x64), in PowerShell
irm https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.ps1 | iex
```

The DMGs are on the [releases page](https://github.com/ritesh-kant/workspaceGPT/releases?q=desktop-v&expanded=true).
Builds cover Apple Silicon and Intel Macs (macOS 12 or later) and Windows x64.
The app updates itself and installs a new version when you quit. The Windows
installer isn't code-signed: `install.ps1` isn't blocked by SmartScreen, but a
browser-downloaded `-setup.exe` needs **More info → Run anyway**.

## Develop

Requirements: the repo's `pnpm install`, plus Rust (`rustup`) for the shell.

| Command | What it does |
|---|---|
| `pnpm --filter desktop dev` | Builds what's missing and runs the Tauri app against the sidecar |
| `pnpm --filter desktop dev:headless` | Runs the sidecar under plain Node and opens the chat in your browser (no Rust needed) |
| `pnpm --filter desktop build` | Bundles the sidecar and bridge into `dist/` |
| `pnpm --filter desktop check-types` | Type-checks the sidecar |
| `pnpm --filter desktop usage-check` | Fails if the extension uses a `vscode.*` API that `vscode-compat` doesn't cover |
| `pnpm --filter desktop seed:from-vscode` | Copies settings from your VS Code install into a desktop profile, once (dev only) |

Useful environment variables are listed under *Dev hooks* in
[NOTES.md](NOTES.md). The ones you'll use most:

- `WGPT_DESKTOP_DATA_DIR=<dir>` uses a scratch profile.
- `WGPT_DESKTOP_SECRETS=memory` keeps the real keychain out of it.
- `WGPT_DESKTOP_ANALYTICS=0` stops test runs from sending analytics.

## Release

`pnpm --filter desktop release` stages the runtime and builds the signed app
for this Mac:

- The runtime is a pinned, SHA-256-checked Node, the sidecar, its native
  modules and the extension's assets.
- The updater signature needs `TAURI_SIGNING_PRIVATE_KEY`, or the key at
  `~/.tauri/workspacegpt-desktop-updater.key`.
- Pass `--target darwin-x64` to cross-build the Intel app. Windows builds
  natively on Windows (`--target win32-x64`, NSIS installer).

Publishing is done by CI. Bump `version` in `package.json`, `src-tauri/tauri.conf.json`
and `src-tauri/Cargo.toml`, merge, then push a `desktop-vX.Y.Z` tag.
[`desktop-publish.yml`](../../.github/workflows/desktop-publish.yml) builds both
Macs and Windows, installs and smoke-tests the Windows build
(`scripts/smoke-installed.mjs`), creates the release and points `desktop-latest` (`latest.json`,
`install.sh`, `install.ps1`) at it.
