# WorkspaceGPT VSCode Extension


[![Version](https://img.shields.io/visual-studio-marketplace/v/Riteshkant.workspacegpt-extension.svg)](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Your AI-powered coding assistant that understands your entire workspace. Get intelligent answers, code explanations, and suggestions based on your project context.

## Features

- 🤖 **Intelligent Code Understanding**: WorkspaceGPT analyzes your entire codebase to provide context-aware assistance
- 💬 **Interactive Chat Interface**: Ask questions and get detailed answers about your code
- 🔍 **Smart Code Navigation**: Get suggestions for navigating through your codebase
- 📝 **Code Explanations**: Receive detailed explanations of code snippets and functions
- ⚡ **Fast Response**: Quick and efficient responses to your coding queries

## Installation

1. Open Visual Studio Code
2. Go to the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X` on macOS)
3. Search for "WorkspaceGPT"
4. Click Install

## Usage

1. Open the WorkspaceGPT sidebar by clicking the WorkspaceGPT icon in the activity bar
2. Use the chat interface to ask questions about your code
3. Use the keyboard shortcut `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (macOS) to quickly access WorkspaceGPT


## Development

### Prerequisites

- Node.js (v18 or higher)
- pnpm package manager

### Setup

1. Clone the repository:
```bash
git clone https://github.com/ritesh-kant/workspaceGPT.git
cd workspaceGPT/apps/vscode-extensions
```

2. Install dependencies:
```bash
pnpm install
```

3. Build the extension:
```bash
pnpm run build
```

### Development Commands

- `pnpm run dev` - Start development environment
- `pnpm run watch` - Watch for changes and rebuild
- `pnpm run lint` - Run ESLint
- `pnpm run test` - Run tests

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

## Support

If you encounter any issues or have questions, please:
1. Check the [documentation](docs/)
2. Open an issue on GitHub
3. Contact the maintainers

## Acknowledgments

- Thanks to all contributors who have helped shape WorkspaceGPT
- Special thanks to the VS Code team for their excellent extension API 