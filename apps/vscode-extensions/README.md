# WorkspaceGPT VSCode Extension

<p align="center">
  <img src="https://github.com/user-attachments/assets/9fe5fd96-b6a4-4671-b095-68abf566b79c" alt="Screenshot 1" width="27%" style="margin-right: 2%" />
  <img src="https://github.com/user-attachments/assets/e61718ab-254d-4f5e-8565-d1a7630612e7" alt="Screenshot 2" width="27%" style="margin-right: 2%" />
  <img src="https://github.com/user-attachments/assets/bf43bb68-542e-4e4f-a4e6-b59b5b7852a2" alt="Screenshot 3" width="27%" />
</p>

[![Version](https://img.shields.io/visual-studio-marketplace/v/Riteshkant.workspacegpt-extension.svg)](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension)

Visit our homepage: [workspacegpt.in](https://workspacegpt.in)

**WorkspaceGPT** is your AI-powered, RAG-based coding assistant designed specifically for your local development environment. It allows you to ask workspace-related questions and get precise answers — all from the comfort of your VSCode editor.

## 🔐 Flexible Privacy Options

WorkspaceGPT gives you control over your data privacy:

- **100% Local Operation**: With Ollama provider, everything runs locally on your system with no data sent to third-party servers
- **Cloud Provider Options**: For enhanced capabilities, you can choose to use cloud-based providers like OpenAI, Gemini, Groq, Requestly, or OpenRouter
- **You Choose**: Select the privacy level that works for your needs while maintaining security

## 🧠 Features

- 🤖 **AI-Powered Workspace Q&A**: Get context-aware answers from your local workspace using Retrieval-Augmented Generation (RAG)
- 📄 **Confluence One-Click Integration**: Seamlessly connect to your Confluence space and chat with your documentation with just one click
- 🔷 **Azure DevOps (ADO) Support**: Deep integration with ADO to track work items, pull requests, and synchronize relevant context directly
- 🧭 **Smart Code Navigation**: Understand and explore your codebase more efficiently (coming soon!)
- 💬 **Interactive Chat Interface**: Ask questions and receive intelligent, project-specific responses
- ⚡ **Runs Locally**: No remote APIs. Zero data leakage. Total privacy.

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