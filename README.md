# Workspace GPT 🧠🚀 (In Development)

**Stop losing time searching for information!** Workspace GPT is an AI-powered knowledge assistant designed to break down data silos and make your organization's collective knowledge instantly accessible **from inside your IDE**. This **Retrieval-Augmented Generation (RAG)** system is **local-first**: by default it runs on a local model (**LLaMA 3.2** via [Ollama](https://ollama.com/)) with local embeddings and a local vector store, so your data can stay entirely on your machine. If you prefer, you can also plug in a cloud provider (OpenAI, Gemini, Groq, and others) — the tradeoff is yours to make.

**Who is this for?** Workspace GPT is designed for developers, product owners, managers, and anyone in your organization who needs quick access to relevant information **without compromising data privacy**.

Workspace GPT helps your organization work smarter, not harder. **All while keeping your data under your control.**

## 🔒 Key Principle: Local-First & Private by Default

**Workspace GPT is built with privacy in mind.** Data extraction, embedding, and storage happen on your machine, and when you use the default local model (Ollama) with a local vector store, **nothing leaves your environment.**

> ⚠️ **Privacy is a choice you control.** If you configure a cloud model or embedding provider (e.g. OpenAI, Gemini, Groq) or a hosted Qdrant instance, the relevant data is sent to that provider. For a fully local setup, use Ollama + a local vector store.

## 🚀 Try it

The easiest way to use Workspace GPT is the **IDE extension** (VS Code, Cursor, and Antigravity via Open VSX):

*   **VS Code Marketplace:** search for `WorkspaceGPT` (`Riteshkant.workspacegpt-extension`)
*   For a **100% local** setup, install [Ollama](https://ollama.com/) and pull a model (e.g. `ollama pull llama3.2`); embeddings and the vector store run locally by default.

The instructions below cover running the monorepo from source for development.

## 🧰 Prerequisites:

Before you begin, ensure you have the following installed:

*   **Node.js:** (v18 or later) - [https://nodejs.org/](https://nodejs.org/)
*   **pnpm:** (latest version) - [https://pnpm.io/](https://pnpm.io/)
*   **Python:** (3.10 or later) - [https://www.python.org/](https://www.python.org/)
*   **Conda:** (latest version) - [https://docs.conda.io/en/latest/](https://docs.conda.io/en/latest/)
*   **Ollama:** (latest version) - [https://ollama.com/](https://ollama.com/)

## 🔹 Supported Data Sources:

*   **Atlassian Confluence:** ✅ (SUPPORTED) — Index Confluence spaces and pages.
*   **Azure DevOps:** ✅ (SUPPORTED) — Index work items and query them in natural language.
*   **Codebase:** 🧪 (EXPERIMENTAL) — Index a **local, checked-out repository** by pointing at its path for code Q&A. This is local-repo indexing, not GitHub-org-wide search.
*   **Jira:** 🚧 (PLANNED) — Scaffolded, but not functional yet.

## 🔹 Key Features:

-   **Smart Q&A:** Developers can ask natural language questions about technical documentation, codebases, and internal best practices, and receive accurate, context-aware answers.
    *   **Example Prompts:**
        *   "How do I use the X library to make a network request?"
        *   "What are the best practices for error handling in our codebase?"
        * "What are the supported authentication methods?"
-   **Ticket Lookup (Azure DevOps):** Retrieve details on your Azure DevOps work items — status, assignees, and more — in natural language. *(Jira support is planned.)*
    *   **Example Prompts:**
        *   "What is the current status of work item 12345?"
        *   "Who is assigned to this bug?"
-   **Code Search (experimental):** Index a local checked-out repository and ask questions about it. Note: this searches embeddings extracted from the local repo you point it at — not remote GitHub repositories.
    *   **Example Prompts:**
        *   "Where is the network call defined?"
        *   "Show me examples of how to use the `calculate_total` function."
-   **Secure & Private:** Designed for internal use. Your indexed data is stored in your own vector database, and with the default local model + local vector store, **it stays on your machine.** Only if you opt into a cloud model/embedding provider is data sent to that provider.

## ⚙️ Installation & Setup:

1.  **Install Dependencies and Prepare the Environment:**
    *   Navigate to the root directory of the project in your terminal.
    *   Run the following command to install the required packages:
        ```bash
        pnpm install
        ```

2.  **Start the Confluence Extractor Service:**
    *   This step extracts data from your confluence. This is a long-running process and can take a while, depending on the amount of data you are trying to pull and the `APP_MODE` setting in your `.env` file. **This process happens entirely locally.**
    *   Run the following command to start the Confluence extractor service:
        ```bash
        pnpm extractor start
        ```
        *   **Note:** The duration of this process will depend on the `APP_MODE` setting in your `.env` file and the size of your Confluence data. The app will try to extract all the pages from confluence and put it in a vector database.
        *   **Limitations:** The app can only extract content from pages. If you have a lot of attachments, they might not be extracted.
        *   **Confluence Extraction Data:** Use `APP_MODE=LITE` in the .env file if you just want to try out the app; it's faster but might not cover all your needs. For better data extraction, use `APP_MODE=STANDARD` or `APP_MODE=EXPERT`.
        *   **Confluence Data Update:** Data extraction is done once. If you need to refresh it, you have to run `pnpm reset:extractor`. This will **locally** clean up the database and restart the extraction.

3.  **Activate conda environment**

    *   Activate the `workspacegpt` Conda environment.
        ```bash
        conda activate workspacegpt
        ```

4.  **Start the Confluence RAG Service:**
    *   Now that the data is extracted, run the service that answers queries against it. **All processing happens locally**.
    *   Run the following command to start the Confluence RAG service:
        ```bash
        pnpm workspaceGPT start
        ```
        *   **Note:** Run this command after each data extraction or if the server crashes.

5.  **Setup Complete!**
    *   The RAG application setup is now complete! You are all set to use it **within your local environment**.
    *   **Next time you want to use WorkspaceGPT, simply run:**
        ```bash
        pnpm workspaceGPT start
        ```
    *   If you have any issues, please check the logs or contact the development team.

## 🚀 Future Enhancements:

*   **Support for More Data Sources:**  We plan to add support for extracting data from other platforms like Slack, Google Drive, and more. **All these features will be implemented with the same commitment to local operation and privacy.**
*   **Improved Code Analysis:** Deeper code understanding, including dependency graphs and code smells detection.
*   **Customizable AI Models:** Allow users to choose and fine-tune their own AI models for specific use cases.
*   **Scheduled Extraction**: Allow users to schedule the extraction of data from their different sources.

*   **Near Term:** Support for GitHub Code
*   **Mid Term:** Support for Google Drive/Slack.
*   **Long Term:** Add a proper UI.

## 🤝 Collaboration

If you are interested in contributing or have ideas for more features, we welcome your collaboration! Please reach out to us or create a pull request with your proposed changes.

## 🙏 Acknowledgments

*   [Ollama](https://ollama.com/)

## ⚠️ Disclaimer

Workspace GPT is currently in active development. Features and functionality may change as the project evolves. **However, the core commitment to local operation and data privacy will remain a fundamental aspect of the project.**

