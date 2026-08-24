# WorkspaceGPT VSCode Extension

<p align="center">
  <img src="https://raw.githubusercontent.com/ritesh-kant/workspacegpt-assets/main/1.png" alt="Screenshot 1" width="27%" style="margin-right: 2%" />
  <img src="https://raw.githubusercontent.com/ritesh-kant/workspacegpt-assets/main/2.png" alt="Screenshot 2" width="27%" style="margin-right: 2%" />
  <img src="https://raw.githubusercontent.com/ritesh-kant/workspacegpt-assets/main/3.png" alt="Screenshot 3" width="27%" />
</p>

[![Version](https://img.shields.io/visual-studio-marketplace/v/Riteshkant.workspacegpt-extension.svg)](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/gagogpeepmgaljpabdlpbcknjnbcaole.svg?label=Chrome%20Web%20Store)](https://chromewebstore.google.com/detail/workspacegpt/gagogpeepmgaljpabdlpbcknjnbcaole)

> 🧩 **New: WorkspaceGPT for Chrome** — ask your Confluence & Azure DevOps questions from a browser side panel. [Add to Chrome](https://chromewebstore.google.com/detail/workspacegpt/gagogpeepmgaljpabdlpbcknjnbcaole), then paste a share code from this extension (Settings → Share to Chrome).

Visit our homepage: [workspacegpt.in](https://workspacegpt.in)

**WorkspaceGPT is the coding agent that knows your whole org.**

Every other coding agent starts from your repo and a prompt. The knowledge about *why* the code should change — the ticket, the design page, the release process — lives in Confluence and Azure DevOps, and you're expected to copy-paste it in. WorkspaceGPT reads it directly, mid-task.

It's a full agent: it searches and reads your code, edits files, runs your tests, and shows you every change for approval before it touches disk.

## 🧭 What makes it different

- **It knows your org, not just your repo.** Your Confluence docs and ADO tickets are first-class context the agent can pull mid-task — ask about a ticket and it can find the design doc *and* the code that implements it.
- **Privacy is architecture, not a promise.** In **Local mode** the model, embeddings, and search index all run on your machine — nothing leaves it, no account, no telemetry. Other tools offer a privacy *policy*; this is a privacy *mode*.
- **It participates in shipping.** Release config-sync and hotfix automation (plan → approve → apply) mean the work doesn't stop at "PR opened."

## 🔐 Two modes, your choice

- **Local mode** — bring your own model via [Ollama](https://ollama.com/), local embeddings, local vector store. **Nothing leaves your machine.** Best for strict environments.
- **Remote mode** — cloud models (Gemini, OpenAI, Groq, OpenRouter, Requestly) and a hosted Qdrant index for speed and quality. You supply the keys; data goes to the providers you choose.

The mode switch is the single seam — Local mode never adds a network dependency.

## 🧠 Features

- 🧑‍💻 **Agentic coding**: The agent reads your code, makes multi-file edits, and runs commands to verify its own work
- ✅ **Review before it writes**: Every file change is shown as a diff you approve or reject; one-click revert restores any checkpoint
- 📄 **Confluence integration**: Connect your space and put your team's documentation in the agent's reach
- 🔷 **Azure DevOps integration**: Work items and PR context synced and searchable
- 🔎 **Codebase understanding**: ripgrep search, symbol/definition/reference lookup, and repo orientation via your editor's language server
- 💬 **@-mentions**: Pull specific files and folders into the conversation
- 🚀 **Release automation**: Config-sync and hotfix pipelines with a terraform-style plan → approve → apply flow
- 🛡️ **Runs offline**: In Local mode, no remote APIs and no data leakage

## 🚀 Getting Started

### Prerequisites

No specific prerequisites required! WorkspaceGPT now supports multiple AI providers:

1. **Ollama** - For 100% local operation
2. **OpenAI** - For powerful cloud-based models
3. **Gemini** - Google's advanced AI models
4. **Groq** - High-performance inference
5. **Requestly** - Custom API integration
6. **OpenRouter** - For access to multiple models

### 🧠 Default Model

By default, WorkspaceGPT uses a lightweight model: `llama3.2:1b` when using Ollama. If you're looking for more accurate and context-rich responses, you can switch to a more capable model that fits your system — such as `llama3.2:4b`, `gemma3:4b`, or `mistral`, or choose one of our cloud provider options.

### Installation

1. Open Visual Studio Code
2. Navigate to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS)
3. Search for **"WorkspaceGPT"**
4. Click **Install**

## 🛠 Setup Guide

1. Open the **WorkspaceGPT** sidebar in VSCode
2. Select your preferred AI provider from the settings menu
3. Configure your selected provider (API keys for cloud providers or connection settings for Ollama)
4. **Confluence**: Go to `Settings > Confluence Integration`, securely sign in with one click, and select workspaces to **"Start Sync"**.
5. **Azure DevOps (ADO)**: Go to `Settings > Azure DevOps`, provide your details, and sync your ADO context to chat with tickets and PRs.

### 🔁 Reset WorkspaceGPT

If you ever need to reset WorkspaceGPT to its default state, simply go to:

`Settings > Reset VSCode State`

## 🧑‍💻 Running the project locally

If you have source access, you can run the project locally:

```bash
pnpm install
pnpm run dev
```

### Development Commands

- `pnpm run dev` - Start development mode
- `pnpm run watch` - Watch for file changes and rebuild
- `pnpm run lint` - Run ESLint
- `pnpm run test` - Run test suite

## 📦 Publishing

The extension is distributed through two registries:

- **VS Code Marketplace** (`vsce`) — used by Microsoft VS Code.
- **Open VSX** (`ovsx`) — used by VS Code forks such as **Antigravity**, Cursor, Windsurf, and VSCodium. The Microsoft Marketplace cannot be used by these forks, so the extension must be on Open VSX to be discoverable there.

### Per-target packages

`onnxruntime-node` (a dependency of the embedding model) ships a separate native binary for every OS/arch. A single universal `.vsix` has to bundle all of them, which produces a 200+ MB package — slow enough to upload that `vsce publish`/`ovsx publish` can appear to hang with no progress output. `pnpm run vscode:publish-all` instead builds and publishes **one `.vsix` per target** (`win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`), each carrying only its own binary. The Marketplace and Open VSX both serve the correct one to each user automatically.

Vendored `onnxruntime-web`/`transformers.js` `.wasm` and `.map` files are stripped from every package regardless of target — the extension only ever runs the Node (`onnxruntime-node`) backend, so that wasm path never executes (see `esbuild.config.js`'s `createDependencyFilter`).

Commands:

- `pnpm run vscode:package` — build and package a single **universal** `.vsix` locally (all platforms bundled). Used for manual install / local testing, not for publishing.
- `pnpm run vscode:package-targets` — build and package all per-target `.vsix` files locally without publishing (useful for checking sizes before a real release).
- `pnpm run vscode:publish-all` — build, package, and publish a `.vsix` per target to **both** registries, then tag the release.
- `pnpm run vscode:publish-pre-release-all` — same, marked as a pre-release.

Both `-all` scripts (`scripts/publish-targets.mjs`) are safe to re-run after a partial failure (e.g. a registry outage mid-way through the target list) — publish calls pass `--skip-duplicate`, so already-published targets are skipped rather than rejected, and the tag is only created once every target succeeds.

Setup for Open VSX (one-time): create a publisher namespace matching `Riteshkant` at [open-vsx.org](https://open-vsx.org), generate an access token, and export it before publishing:

```bash
export OVSX_TOKEN=<token>
pnpm run vscode:publish-all
```

> Manual install (any fork): `pnpm run vscode:package`, then use the IDE's **Install from VSIX** action.

## 📄 License

This software is proprietary. See the [LICENSE.md](LICENSE.md) file for more details.

## 💬 Support

Have questions or issues?

1. Check the [documentation](docs/)
2. Open an issue on GitHub
3. Email us at contact@workspacegpt.in
4. Reach out to the maintainers

## 🙏 Acknowledgments

- Big thanks to the VSCode team for a powerful extension API
- And to all the contributors who help shape WorkspaceGPT

---

**WorkspaceGPT** – Talk to your code and your Confluence docs. Locally, privately, and intelligently.