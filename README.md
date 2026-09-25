# WorkspaceGPT — the coding agent that knows your whole org

> 🧭 **Where this project is headed:** [NORTH-STAR.md](NORTH-STAR.md). Read it before proposing or building any feature.

Other coding agents start from your repo and a prompt. The knowledge about *why* the code should change (the ticket, the design page, the runbook, the decision nobody wrote in a code comment) lives in **Confluence** and **Azure DevOps**, and you're expected to copy-paste it in.

**WorkspaceGPT reads it directly, mid-task.** Pick a work item and the agent pulls its acceptance criteria and the Confluence pages behind it, then searches your code, makes the edits, runs your lint, type-check and tests, and shows you every change as a diff before it touches disk.

## 🧭 What makes it different

- **It knows your org, not just your repo.** Your Confluence docs and ADO work items are first-class context the agent pulls mid-task, and its answers cite them.
- **Privacy is architecture, not a promise.** Embeddings and the search index are always on your machine. In **Local mode** the model runs there too (Ollama or your own key), so nothing leaves it and no account is needed. In **Remote mode** we run the model; your documents and index still stay local.
- **It participates in shipping.** Release config-sync and hotfix automation (plan → approve → apply) mean the work doesn't stop at "PR opened".

## 🧠 The org knowledge it reads

*   **Atlassian Confluence** ✅: spaces and pages (design docs, runbooks, decisions).
*   **Azure DevOps** ✅: work items and PR context; your assigned items open in the sidebar.
*   **Jira** 🚧: planned.
*   **Your open workspace**: live text search, file reads and language-server navigation. No codebase index is created or stored.

## 🚀 Try it

*   **IDE extension** (VS Code, Cursor, and Antigravity via Open VSX): search for `WorkspaceGPT` (`Riteshkant.workspacegpt-extension`).
*   **Desktop app**: download from [Releases](https://github.com/ritesh-kant/workspaceGPT/releases/latest).
*   Then open **Settings › Knowledge** and connect Confluence and Azure DevOps.

Homepage: [workspacegpt.in](https://www.workspacegpt.in). The instructions below cover running the monorepo from source for development.

## 🧰 Prerequisites:

Before you begin, ensure you have the following installed:

*   **Node.js:** (v18 or later) - [https://nodejs.org/](https://nodejs.org/)
*   **pnpm:** (latest version) - [https://pnpm.io/](https://pnpm.io/)
*   **Python:** (3.10 or later) - [https://www.python.org/](https://www.python.org/)
*   **Conda:** (latest version) - [https://docs.conda.io/en/latest/](https://docs.conda.io/en/latest/)
*   **Ollama:** (latest version) - [https://ollama.com/](https://ollama.com/)


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
