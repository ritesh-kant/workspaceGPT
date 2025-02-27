# Workspace GPT 🧠🚀 (In Development)

**Stop losing time searching for information!** Workspace GPT is an AI-powered knowledge assistant designed to break down data silos and make your organization's collective knowledge instantly accessible **within your own local environment**. This **Retrieval-Augmented Generation (RAG)** system, powered by the **LLaMA 3.2** model, centralizes information from various sources, allowing your teams to focus on what matters most: building great products. **Crucially, all operations are performed locally, ensuring complete data privacy and security.**

**Who is this for?** Workspace GPT is designed for developers, product owners, managers, and anyone in your organization who needs quick access to relevant information **without compromising data privacy**.

Workspace GPT helps your organization work smarter, not harder. **All while keeping your data under your control.**

## 🔒 Key Principle: Local-Only & Completely Private

**Workspace GPT is built from the ground up with privacy in mind.**  All data extraction, processing, and querying happen **entirely within your local environment**. No data is ever sent to the internet or any external servers. Your organizational knowledge remains completely private and secure.

## 🧰 Prerequisites:

Before you begin, ensure you have the following installed:

*   **Node.js:** (v18 or later) - [https://nodejs.org/](https://nodejs.org/)
*   **pnpm:** (latest version) - [https://pnpm.io/](https://pnpm.io/)
*   **Python:** (3.10 or later) - [https://www.python.org/](https://www.python.org/)
*   **Conda:** (latest version) - [https://docs.conda.io/en/latest/](https://docs.conda.io/en/latest/)
*   **Ollama:** (latest version) - [https://ollama.com/](https://ollama.com/)

## 🔹 Supported Data Sources:

*   **Atlassian Confluence:** (SUPPORTED) - Extract data from Confluence spaces and pages.
*   **Codebase:** (IN PROGRESS) -  Currently working on extracting information directly from code repositories.
*   **Jira/Azure DevOps:** (TBD) - Support for Jira and Azure DevOps integration is planned for the future.

## 🔹 Key Features:

-   **Smart Q&A:** Developers can ask natural language questions about technical documentation, codebases, and internal best practices, and receive accurate, context-aware answers.
    *   **Example Prompts:**
        *   "How do I use the X library to make a network request?"
        *   "What are the best practices for error handling in our codebase?"
        * "What are the supported authentication methods?"
-   **Ticket Lookup:** Product owners can quickly retrieve the latest details on any Jira issue, including status, assignees, and comments, saving valuable time.
    *   **Example Prompts:**
        *   "What is the current status of ABC-123?"
        *   "Who is assigned to ticket XYZ-456?"
        *   "Show me all the comments on issue DEF-789."
-   **Code Search:** Engineers can effortlessly locate relevant code snippets across your entire codebase, complete with code analysis and associated documentation links.
    *   **Example Prompts:**
        *   "Find all the functions that use the Y class."
        *   "Show me examples of how to use the `calculate_total` function."
        * "Where is the network call defined?"
-   **Secure & Private:** Designed for internal use, ensuring organizational data privacy. All data stays within your organization's infrastructure, and access is controlled via secure authentication. **All operations occur locally. Data is stored in your own vector database, and no data is ever sent outside your environment.**

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

