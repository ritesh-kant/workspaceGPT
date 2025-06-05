# WorkspaceGPT VSCode Extension

<p align="center">
  <img src="https://raw.githubusercontent.com/ritesh-kant/workspaceGPT/main/apps/vscode-extensions/resources/screenshots/1.png" alt="Screenshot 1" width="27%" style="margin-right: 2%" />
  <img src="https://raw.githubusercontent.com/ritesh-kant/workspaceGPT/main/apps/vscode-extensions/resources/screenshots/2.png" alt="Screenshot 2" width="27%" style="margin-right: 2%" />
  <img src="https://raw.githubusercontent.com/ritesh-kant/workspaceGPT/main/apps/vscode-extensions/resources/screenshots/3.png" alt="Screenshot 3" width="27%" />
</p>

[![Version](https://img.shields.io/visual-studio-marketplace/v/Riteshkant.workspacegpt-extension.svg)](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WorkspaceGPT** is your AI-powered, RAG-based coding assistant designed specifically for your local development environment. It allows you to ask workspace-related questions and get precise answers — all from the comfort of your VSCode editor.

## 🔐 Flexible Privacy Options

WorkspaceGPT gives you control over your data privacy:

- **100% Local Operation**: With Ollama provider, everything runs locally on your system with no data sent to third-party servers
- **Cloud Provider Options**: For enhanced capabilities, you can choose to use cloud-based providers like OpenAI, Gemini, Groq, Requestly, or OpenRouter
- **You Choose**: Select the privacy level that works for your needs while maintaining security

## 🧠 Features

- 🤖 **AI-Powered Workspace Q&A**: Get context-aware answers from your local workspace using Retrieval-Augmented Generation (RAG)
- 📄 **Confluence Integration**: Seamlessly connect to your Confluence space and chat with your documentation
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
4. For Confluence integration, go to `Settings > Confluence Integration`
5. Enter your Confluence details
6. Click **"Check Connection"** to verify access and fetch the total number of pages
7. Click **"Start Sync"** to begin syncing your Confluence content (this may take time depending on the number of pages)

### 🔁 Reset WorkspaceGPT

If you ever need to reset WorkspaceGPT to its default state, simply go to:

`Settings > Reset VSCode State`

## 🧑‍💻 For Opensource contribution or to run the project locally

Clone the repo and start hacking!

```bash
git clone https://github.com/ritesh-kant/workspaceGPT.git
cd workspaceGPT/apps/vscode-extensions
pnpm install
pnpm run dev
```

### Development Commands

- `pnpm run dev` - Start development mode
- `pnpm run watch` - Watch for file changes and rebuild
- `pnpm run lint` - Run ESLint
- `pnpm run test` - Run test suite

## 🤝 Contributing

We welcome contributions! Here's how:

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to your branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License. See the [LICENSE.md](LICENSE.md) file for more info.

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