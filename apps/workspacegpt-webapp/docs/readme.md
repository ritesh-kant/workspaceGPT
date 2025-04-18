# WorkspaceGPT – Website Structure & App Flow

> This document outlines the structure, features, and user journey of the WorkspaceGPT marketing website, inspired by [cursor.com](https://www.cursor.com). The goal is to help a web developer implement an engaging, informative, and conversion-optimized website that reflects the product's capabilities.

---

## 🌐 Website Overview

**WorkspaceGPT** is a local, private, AI-powered coding assistant integrated into VS Code. The website will showcase its value, features, screenshots, setup instructions, and include download & documentation links.

---

## 🛠️ Tech to Use

| Purpose     | Technology |
|-------------|------------|
| Frontend    | [Next.js](https://nextjs.org/) |
| Styling     | Tailwind CSS |
| Animations  | Framer Motion |
| Icons       | Lucide / Heroicons |
| Docs / MDX  | Nextra or Docusaurus |
| Payment     | [Razorpay](https://razorpay.com/) |

> Razorpay will be used for processing payments if you plan to offer premium features, licensing, or paid support.

---

## 📁 Page Structure

### 1. Home Page (`/`)

**Sections:**

- **Hero Section**
  - Bold headline (e.g., *"Talk to your code. Privately, locally."*)
  - Subheading describing WorkspaceGPT as a 100% local RAG-based AI assistant for developers
  - Call-to-Action buttons:  
    - ✅ `Install in VS Code`  
    - 📄 `View Docs`
  - Background animation or looped demo GIF

- **Core Features**
  - Icon + Title + Short description (grid layout)
    - 🤖 AI-Powered Workspace Q&A
    - 📄 Confluence Docs Integration
    - 💬 Interactive Chat in VSCode
    - 🔐 100% Local – Private & Secure
    - 🧭 Smart Code Navigation (Coming soon)

- **How It Works (Flow)**
  - Visual steps or horizontal timeline:
    1. Install the VS Code extension
    2. Start Ollama locally
    3. Ask questions inside the chat interface
    4. Get answers based on your codebase and Confluence docs

- **Screenshots**
  - Carousel or 3-column layout with preview images from the extension
  - Each image can expand on click

- **Model Flexibility**
  - Explain how users can run their own models using Ollama (with CLI examples)
  - Mention supported models: `llama3.2:1b`, `llama3.2:4b`, `gemma3:4b`, `mistral`

- **Privacy & Security**
  - Emphasize 100% local execution
  - No cloud APIs, telemetry, or remote logging

- **Testimonials / Developer Love**
  - Short quotes (real or placeholder) from devs who use the tool

- **Installation Steps**
  - 3–4 step guide with icons:
    1. Install VS Code Extension
    2. Install Ollama
    3. Run a model
    4. Start using WorkspaceGPT

- **FAQ**
  - A few collapsible FAQs (see below)

- **Call-to-Action Footer**
  - Install now → `Install WorkspaceGPT`
  - GitHub → `Star us on GitHub`
  - Docs → `Explore Documentation`

---

### 2. Documentation Page (`/docs`)

- Markdown-powered docs site (optionally generated via Docusaurus or Next.js MDX)
- Sections:
  - Overview
  - Installation
  - Setting up Ollama
  - Syncing Confluence
  - Using Chat
  - Developer Setup
  - FAQ

---

### 3. Download/Install Page (`/install`)

- Visual instructions to:
  - Install via Marketplace (with badge)
  - Start Ollama
  - Use default or custom model
  - Launch and use the extension

---

## ⚙️ App Flow (For Users)

Here’s how a user typically interacts with WorkspaceGPT:

1. **Download & Install**
   - User installs WorkspaceGPT from VS Code Marketplace
   - Installs Ollama CLI

2. **Choose & Start Model**
   - Runs a model like:
     ```bash
     ollama run llama3.2:4b
     ```

3. **Open Chat in VSCode**
   - Opens the WorkspaceGPT sidebar in VSCode
   - Enters a prompt like:  
     *“What does the `auth.service.ts` file do?”*

4. **Behind the Scenes (RAG Flow)**
   - WorkspaceGPT indexes the codebase (locally)
   - If Confluence is connected, indexed docs are included
   - Based on the query, relevant code/doc chunks are retrieved
   - The LLM generates a response based on the context

5. **Response is Rendered**
   - Answer is shown in the chat window
   - User can refine the question, follow up, or explore code via smart navigation (coming soon)

---

## 🧩 Core Features (Detailed)

### 🤖 AI-Powered Q&A
- Uses RAG (Retrieval-Augmented Generation)
- Answers questions specific to your codebase
- Useful for understanding large or unfamiliar projects

### 📄 Confluence Integration
- Configure credentials inside settings
- Sync content locally and ask questions about internal docs

### 💬 Interactive Chat
- Sidebar chat UI inside VS Code
- Works like ChatGPT, but context-aware

### 🧭 Smart Code Navigation *(Coming Soon)*
- Jump to files, symbols, or functions based on query
- e.g., *“Show me where `getUserDetails` is defined”*

### 🔐 100% Local Execution
- No API calls or telemetry
- LLM and vector DB run on your system

---

## ❓ Sample FAQ

**Q: Does WorkspaceGPT work offline?**  
Yes. All components (LLM, vector DB, indexing) run locally. No internet required after setup.

**Q: Can I use any model?**  
You can run any model supported by [Ollama](https://ollama.com). Common options: `llama3.2:1b`, `mistral`, `gemma`.

**Q: Is Confluence integration secure?**  
Yes. We don’t store or send your credentials. Content is fetched and processed locally.

**Q: Can I use it without Confluence?**  
Absolutely. Confluence is optional. WorkspaceGPT works just with your local codebase too.

---

## 🔗 External Links

- [GitHub Repo](https://github.com/ritesh-kant/workspaceGPT)
- [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension)
- [Ollama Installation](https://ollama.com)

---

## 📣 Final Note

The website should reflect **simplicity**, **privacy**, and **developer empowerment**. Visual inspiration can be taken from sites like cursor.com, linear.app, and raycast.com.