# Workspace GPT 🧠🚀 (In Development)

**Stop losing time searching for information!** Workspace GPT is an AI-powered knowledge assistant designed to break down data silos and make your organization's collective knowledge instantly accessible. This **Retrieval-Augmented Generation (RAG)** system, powered by the **LLaMA 3.2** model, centralizes information from various sources, allowing your teams to focus on what matters most: building great products.

**Who is this for?** Workspace GPT is designed for developers, product owners, managers, and anyone in your organization who needs quick access to relevant information.

Workspace GPT helps your organization work smarter, not harder.

## 🧰 Prerequisites:

Before you begin, ensure you have the following installed:

*   **Node.js:** (v18 or later) - [https://nodejs.org/](https://nodejs.org/)
*   **pnpm:** (latest version) - [https://pnpm.io/](https://pnpm.io/)
*   **Python:** (3.10 or later) - [https://www.python.org/](https://www.python.org/)
*   **Conda:** (latest version) - [https://docs.conda.io/en/latest/](https://docs.conda.io/en/latest/)
* **Ollama**: (latest version) - [https://ollama.com/](https://ollama.com/)

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
-   **Secure & Private:** Designed for internal use, ensuring organizational data privacy. All data stays within your organization's infrastructure, and access is controlled via secure authentication. Data is stored in your own vector database, and no data is sent outside.

## ⚙️ Installation & Setup:

1.  **Environment Configuration:**
    *   Copy the `.env.example` file to `.env`:
        ```bash
        cp .env.example .env
        ```
    *   Open the newly created `.env` file and fill in the necessary details according to your environment and needs.
    *   **Note:** The `APP_MODE` controls how the app behaves, such as the amount of data extracted from confluence. It can be used for dev/prod/test mode.

2.  **Install Dependencies:**
    *   Navigate to the root directory of the project in your terminal.
    *   Run the following command to install the required packages:
        ```bash
        pnpm install
        ```

3.  **Prepare the Environment:**
    *   Run the preparation script:
        ```bash
        pnpm run prepare
        ```

4.  **Start the Confluence Extractor Service:**
    * This step extracts data from your confluence, this is a long running process and can take a while depending on the amount of data you are trying to pull.
    * This is one time service, no need to rerun it again unless you want to refresh the data.
    *   Run the following command to start the Confluence extractor service:
        ```bash
        pnpm run app:confluence-extractor start
        ```
        *   **Note:** The duration of this process will depend on the `APP_MODE` setting in your `.env` file and the size of your Confluence data. The app will try to extract all the pages from confluence and put it in a vector database.
        *   **Limitations:** The app can only extract content from pages, if you have a lot of attachments, they might not be extracted.
        * **Confluence Extraction Data**: The max size of the data extracted depends on the `APP_MODE`, if you have a lot of data to extract, consider updating the `.env` file, and check the current limits of your vector database.
        * **Confluence Data Update**: Data extraction is done once, if you need to refresh it, you have to rerun this command.

5. **Create Confluence RAG Environment**
    * Run the following command
    ```bash
    pnpm run app:confluence-rag env:create
    ```

6. **Setup Ollama**
    * Download your model:
    ```bash
    ollama pull llama3
    ```
    * For more info about how to use ollama, see [https://ollama.com/](https://ollama.com/)

7. **Activate conda environment**
    * Create a conda environment:
    ```bash
    conda create -n workspacegpt python=3.10
    ```
     *   Activate the `workspacegpt` Conda environment.
        ```bash
        conda activate workspacegpt
        ```

8.  **Start the Confluence RAG Service:**
    *   Now that the data is extracted, run the service that answers query against it.
    *   Run the following command to start the Confluence RAG service:
        ```bash
        pnpm run app:confluence-rag start
        ```
        * **Note:** Run this command after each data extraction or if the server crashes.

9.  **Setup Complete!**
    *   The RAG application setup is now complete! You are all set to use it.
    *   **Next time you want to use WorkspaceGPT, simply run:**
        ```bash
        pnpm run app:confluence-rag start
        ```
    * If you have any issues, please check the logs in the `logs` folder or contact the development team.

## 🚀 Future Enhancements:

*   **Support for More Data Sources:**  We plan to add support for extracting data from other platforms like Slack, Google Drive, and more.
*   **Improved Code Analysis:** Deeper code understanding, including dependency graphs and code smells detection.
*   **Customizable AI Models:** Allow users to choose and fine-tune their own AI models for specific use cases.
* **Scheduled Extraction**: Allow user to schedule the extraction of data from their different sources.

* **Near Term**: Support for Github Code
* **Mid Term**: Support for Google Drive/Slack.
* **Long Term**: Add a proper UI.

##🤝 Collaboration

If you are interested in contributing or have ideas for more features, we welcome your collaboration! Please reach out to us or create a pull request with your proposed changes.

## 🙏 Acknowledgments

* [Ollama](https://ollama.com/)

## ⚠️ Disclaimer

Workspace GPT is currently in active development. Features and functionality may change as the project evolves.
