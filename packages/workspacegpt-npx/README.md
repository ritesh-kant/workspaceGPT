# workspacegpt

Installs [WorkspaceGPT Desktop](https://github.com/ritesh-kant/workspaceGPT), a coding agent grounded in your organisation's Knowledge (Confluence, Jira and Azure DevOps), on macOS or Windows.

```bash
npx workspacegpt
```

Needs Node.js 18 or later. It downloads this machine's build from the latest release, checks its SHA-256, and installs it for your user (no admin prompt). Run it again to update.

It runs the same installer scripts as the one-line installs:

- macOS: `curl -fsSL https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.sh | sh`
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.ps1 | iex"`

The app isn't code-signed yet; the release notes cover the one-time OS prompt.
