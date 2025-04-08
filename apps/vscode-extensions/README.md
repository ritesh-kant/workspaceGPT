# WorkspaceGPT VSCode Extension


[![Version](https://img.shields.io/visual-studio-marketplace/v/Riteshkant.workspacegpt-extension.svg)](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**WorkspaceGPT** is your AI-powered, RAG-based coding assistant designed specifically for your local development environment. It allows you to ask workspace-related questions and get precise answers — all from the comfort of your VSCode editor.

## 🔐 100% Local & Private

Everything in WorkspaceGPT runs **locally** on your system. No data is sent to third-party servers. Your code and your documents remain **fully private and secure**. You don’t need to worry about confidentiality — we don’t share or transmit anything outside your machine.

## 🧠 Features

- 🤖 **AI-Powered Workspace Q&A**: Get context-aware answers from your local workspace using Retrieval-Augmented Generation (RAG)
- 📄 **Confluence Integration**: Seamlessly connect to your Confluence space and chat with your documentation
- 🧭 **Smart Code Navigation**: Understand and explore your codebase more efficiently (coming soon!)
- 💬 **Interactive Chat Interface**: Ask questions and receive intelligent, project-specific responses
- ⚡ **Runs Locally**: No remote APIs. Zero data leakage. Total privacy.

## 🚀 Getting Started

### Prerequisites

- [Ollama](https://ollama.com) installed and running locally
- Node.js (v18 or higher)

### Installation

1. Open Visual Studio Code
2. Navigate to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS)
3. Search for **"WorkspaceGPT"**
4. Click **Install**

## 🛠 Setup Guide

1. Make sure Ollama is running on your system
2. Open the **WorkspaceGPT** sidebar in VSCode
3. Go to `Settings > Confluence Integration`
4. Enter your Confluence details
5. Click **"Check Connection"** to verify access and fetch the total number of pages
6. Click **"Start Sync"** to begin syncing your Confluence content (this may take time depending on the number of pages)

### 🔁 Reset WorkspaceGPT

If you ever need to reset WorkspaceGPT to its default state, simply go to:

`Settings > Reset VSCode State`

## 🧑‍💻 Development

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
3. Reach out to the maintainers

## 🙏 Acknowledgments

- Big thanks to the VSCode team for a powerful extension API
- And to all the contributors who help shape WorkspaceGPT

---

**WorkspaceGPT** – Talk to your code and your Confluence docs. Locally, privately, and intelligently.