/**
 * Landing pages for the searches our buyers actually type ("AI coding agent
 * for Confluence", "Azure DevOps AI agent"…). Each is one entry here, rendered
 * by /use-cases/[slug]. Every claim must already be true on the home page or in
 * the docs — these pages rank on specifics, and a wrong specific is worse than
 * a vague one. Keep each page's copy distinct; near-duplicates get folded
 * together by search engines.
 */

export type UseCase = {
  slug: string;
  /** <title> (the layout template appends "| WorkspaceGPT"). */
  title: string;
  /** Shown as the page heading. */
  h1: string;
  description: string;
  lede: string;
  /** Short label used in cross-links. */
  label: string;
  problem: { heading: string; body: string[] };
  steps: { title: string; body: string }[];
  points: { title: string; body: string }[];
  faq: { q: string; a: string }[];
  /** ISO date the copy last changed, for the sitemap. */
  updated: string;
};

export const USE_CASES: UseCase[] = [
  {
    slug: "confluence-ai-coding-agent",
    label: "Confluence",
    title: "AI Coding Agent for Confluence — Code From Your Design Docs",
    h1: "The AI coding agent that reads your Confluence",
    description:
      "WorkspaceGPT is a coding agent that searches your Confluence pages mid-task, edits and verifies your code against them, and can update the page afterwards. Indexed on your machine, zero data retention.",
    lede:
      "Most coding agents start from your repo and a prompt. The reason a change is built the way it is usually lives in a Confluence page — the retry policy, the API contract, the architecture decision. WorkspaceGPT reads that page while it works, so the code it writes matches the documentation your team actually follows.",
    problem: {
      heading: "Your design docs aren't in the repo",
      body: [
        "Ask a general-purpose agent why a payment retry is capped at three and it will guess from the code. The real answer is in a Confluence page two clicks away from the person who asked.",
        "WorkspaceGPT syncs the Confluence spaces you choose, builds a search index from them on your own machine, and lets the agent search it in the middle of a task, next to its code search. Answers cite the page they came from, so you can check the source instead of trusting a summary.",
      ],
    },
    steps: [
      {
        title: "Connect Confluence",
        body: "Sign in once and pick the spaces to sync. Pages are fetched to your machine and embedded on-device.",
      },
      {
        title: "Ask, or hand it a task",
        body: "The agent searches your pages and your code together, reads what it needs, and cites the Confluence page and the file it relied on.",
      },
      {
        title: "Edit, verify, document",
        body: "It edits your code, runs your linter, type-checker and tests, and — when the docs have drifted — proposes the Confluence edit as a review card you approve before anything is written.",
      },
    ],
    points: [
      {
        title: "Grounded, with sources",
        body: "Every answer names the Confluence page and the code it drew on. If a page doesn't say, the agent says so rather than inventing it.",
      },
      {
        title: "Edits and creates pages",
        body: "Fix the out-of-date section or write the new page when the work is done. Changes wait on a review card — nothing is published without your approval.",
      },
      {
        title: "Index stays on your machine",
        body: "Embeddings are generated on-device and the vector index is stored in local files. Your Confluence content is never uploaded to build it.",
      },
      {
        title: "VS Code, Cursor, Antigravity or Desktop",
        body: "Install the extension in your editor or run WorkspaceGPT Desktop for macOS or Windows. It is the same agent either way.",
      },
    ],
    faq: [
      {
        q: "Can an AI coding agent read Confluence?",
        a: "Yes. WorkspaceGPT syncs the Confluence spaces you connect, indexes them on your machine, and the agent searches those pages mid-task alongside your code, then cites the page it used.",
      },
      {
        q: "Does WorkspaceGPT upload my Confluence pages?",
        a: "No. Indexing and embeddings run on your device and the search index is written to local files, in both Local and Remote mode. In Remote mode only your question and the snippets retrieved for it reach our endpoint, and nothing is stored.",
      },
      {
        q: "Can it edit Confluence pages?",
        a: "Yes. It can edit a section of an existing page or create a new one. Each change is shown as a review card and is only written after you approve it.",
      },
      {
        q: "Which editors are supported?",
        a: "VS Code, Cursor and Antigravity IDE through the extension, or WorkspaceGPT Desktop, a standalone app for macOS and Windows.",
      },
    ],
    updated: "2026-10-10",
  },
  {
    slug: "azure-devops-ai-coding-agent",
    label: "Azure DevOps",
    title: "AI Coding Agent for Azure DevOps Work Items — Ticket to Verified Fix",
    h1: "The AI coding agent that starts from your Azure DevOps ticket",
    description:
      "WorkspaceGPT lists the Azure DevOps work items assigned to you, reads the ticket and the Confluence design page behind it, fixes the code, runs your tests and reports back on the ticket. Zero data retention.",
    lede:
      "Your work starts as a work item, not a prompt. WorkspaceGPT opens on the Azure DevOps items assigned to you, so you can start a run straight from a bug or user story — with the ticket, its history and the related design docs already in context.",
    problem: {
      heading: "A ticket isn't a prompt",
      body: [
        "Copying a work item into a chat window loses the acceptance criteria, the linked discussion and the design page the ticket assumes you've read. The agent builds the wrong thing quickly.",
        "WorkspaceGPT reads the work item itself, searches your connected Confluence and Jira knowledge for the context around it, and works through the change in the open: analyse, plan, implement, run the checks, verify.",
      ],
    },
    steps: [
      {
        title: "Connect Azure DevOps",
        body: "Your assigned work items appear in the sidebar with their type, state and sprint when you open it.",
      },
      {
        title: "Start from the ticket",
        body: "Pick an item and start a run. The agent reads the work item, then searches your docs and code for the rest of the picture.",
      },
      {
        title: "Verify, then hand it back",
        body: "It runs your linter, type-checker and tests, writes a report of what changed and what passed, and can post that report on the ticket. Create PR commits only what the agent changed to a fresh branch.",
      },
    ],
    points: [
      {
        title: "Your work, on open",
        body: "No pasting ticket numbers. The sidebar lists what is assigned to you and suggests the next action.",
      },
      {
        title: "Checked, not just generated",
        body: "A run isn't finished when the code is written. It runs your project's own checks and reports which passed, so you start review from evidence.",
      },
      {
        title: "As hands-off as you want",
        body: "Let it edit on its own, have it plan first, or review every diff. A checkpoint is taken before the first write, so one click reverts the whole turn.",
      },
      {
        title: "Private by architecture",
        body: "Work items are indexed on your machine. We store no prompts, answers or documents, and nothing you ask is used to train a model.",
      },
    ],
    faq: [
      {
        q: "Can an AI agent work on Azure DevOps work items?",
        a: "Yes. WorkspaceGPT reads the Azure DevOps items assigned to you, starts a run from one, and grounds the work in the ticket and the related Confluence and Jira knowledge you've connected.",
      },
      {
        q: "Is this an alternative to GitHub Copilot for Azure DevOps teams?",
        a: "It is a different tool for a different starting point: WorkspaceGPT is built around the ticket and your org's documentation rather than the open file. It can also use your GitHub Copilot plan as its model in Local mode.",
      },
      {
        q: "Does it open pull requests?",
        a: "Create PR commits only what the agent changed to a fresh branch, pushes it, and opens your host's new-pull-request page with the run's report filled in.",
      },
      {
        q: "Where does my Azure DevOps data go?",
        a: "Work items are synced to your machine and indexed there. The index never leaves it, and WorkspaceGPT retains nothing server-side.",
      },
    ],
    updated: "2026-10-10",
  },
  {
    slug: "jira-ai-coding-agent",
    label: "Jira",
    title: "AI Coding Agent for Jira and Confluence — Grounded in Your Tickets",
    h1: "The AI coding agent that reads your Jira issues and Confluence docs",
    description:
      "WorkspaceGPT syncs your Jira issues and Confluence pages, indexes them on your machine, and lets a coding agent pull both mid-task so its code changes match the ticket and the spec. Zero data retention.",
    lede:
      "A Jira issue says what to build; the Confluence page says how your team builds it. WorkspaceGPT keeps both searchable on your machine and lets the coding agent read them together while it works, instead of guessing from the code alone.",
    problem: {
      heading: "The context is split across two tools",
      body: [
        "The issue has the request and the discussion. The spec has the constraints. A coding agent that sees neither will produce plausible code that ignores both.",
        "WorkspaceGPT syncs Jira issues and Confluence pages into one local index and searches them together with your code, so a single question can draw on the ticket, the design page and the implementation.",
      ],
    },
    steps: [
      {
        title: "Connect Jira and Confluence",
        body: "Authorize once and choose what to sync. Issues and pages are embedded on-device.",
      },
      {
        title: "Ask across all of it",
        body: "Ask why something was built the way it was, or give the agent a task. It searches issues, pages and code, and cites each source it used.",
      },
      {
        title: "Use it from your other tools too",
        body: "WorkspaceGPT ships an MCP server that exposes your Jira, Confluence and Azure DevOps search to Claude Desktop, Cursor and other MCP clients.",
      },
    ],
    points: [
      {
        title: "Issues and docs, searched together",
        body: "One index across Jira, Confluence and your code, so the answer isn't limited to whichever tool you happened to open.",
      },
      {
        title: "Cited answers",
        body: "Each answer names the issue, page or file it relied on, so you can verify it in a click.",
      },
      {
        title: "Works with the editor you have",
        body: "VS Code, Cursor, Antigravity, or WorkspaceGPT Desktop for macOS and Windows.",
      },
      {
        title: "Nothing stored on our side",
        body: "The index lives in local files, embeddings are generated on-device, and we retain no prompts, answers or documents.",
      },
    ],
    faq: [
      {
        q: "Can a coding agent read Jira issues?",
        a: "Yes. WorkspaceGPT syncs the Jira issues you connect, indexes them on your machine, and the agent searches them mid-task together with your Confluence pages and code.",
      },
      {
        q: "Do I need Jira and Confluence both?",
        a: "No. The agent works with whichever Knowledge you've connected — Jira, Confluence or Azure DevOps, in any combination.",
      },
      {
        q: "Can I use my Jira and Confluence search in Claude Desktop or Cursor?",
        a: "Yes. WorkspaceGPT includes an MCP server that exposes that search to Claude Desktop, Cursor and other MCP clients.",
      },
      {
        q: "Is my Jira data sent to a third party?",
        a: "Indexing and embeddings stay on your device. In Local mode with Ollama nothing leaves your computer; in Remote mode only your question and the retrieved snippets reach our endpoint, and nothing is stored.",
      },
    ],
    updated: "2026-10-10",
  },
  {
    slug: "private-ai-coding-agent",
    label: "Privacy",
    title: "Private AI Coding Agent — Zero Data Retention, Runs Offline",
    h1: "A coding agent that can prove it never stores your data",
    description:
      "WorkspaceGPT is an AI coding agent with zero data retention. Run it fully offline with Ollama, or use Remote mode where your index stays on-device and we store no prompts, answers or documents.",
    lede:
      "Security teams veto coding tools that hold code on someone else's server. WorkspaceGPT is built so there is nothing to hold: indexing and embeddings run on your machine, the index is local files, and in Local mode with Ollama no request leaves your computer at all.",
    problem: {
      heading: "Privacy as architecture, not a policy toggle",
      body: [
        "A privacy mode is a promise about what a vendor does with data it already received. WorkspaceGPT's approach is to never receive it: your documents and the vector index built from them stay on your device in both modes.",
        "That makes it easier to get through a security review, and easier to use on the repositories and internal documentation you wouldn't paste into a hosted chat.",
      ],
    },
    steps: [
      {
        title: "Local mode — free",
        body: "Run the chat model on your own hardware with Ollama, or use your GitHub Copilot plan or your own provider key. No account is needed, and with a local model it runs offline.",
      },
      {
        title: "Remote mode — managed model",
        body: "We host the inference so there is nothing to configure. Only your question and the snippets retrieved for it reach our endpoint, are processed in memory, and are discarded.",
      },
      {
        title: "Same agent either way",
        body: "Search, multi-file edits, test runs and Confluence, Jira and Azure DevOps grounding work the same in both modes.",
      },
    ],
    points: [
      {
        title: "On-device indexing",
        body: "Embeddings are generated locally and the vector index is written to local files. Your documents are not uploaded to build it.",
      },
      {
        title: "Zero data retention",
        body: "No prompts, answers or documents are stored, not even in logs. Usage analytics count features and never carry content.",
      },
      {
        title: "Never used for training",
        body: "Nothing you ask is used to train a model, sold or shared.",
      },
      {
        title: "Secrets in your keychain",
        body: "Credentials are kept in your host's secret storage, not in settings files.",
      },
    ],
    faq: [
      {
        q: "Is there an AI coding agent that works offline?",
        a: "Yes. In Local mode with Ollama there are no remote APIs at all, so the whole agent loop runs on your machine with no account.",
      },
      {
        q: "Does WorkspaceGPT store my code or prompts?",
        a: "No. It retains no prompts, answers or documents. In Remote mode a request is processed in memory and discarded.",
      },
      {
        q: "Is it suitable for regulated or security-conscious teams?",
        a: "It is designed for them: the knowledge index never leaves the device, there is a zero-retention policy you can read in full on the privacy page, and Local mode needs no external service.",
      },
      {
        q: "What does Remote mode send to your servers?",
        a: "Only your question and the snippets retrieved for it. Inference is performed by an upstream model provider under its own policy, which the privacy policy documents.",
      },
    ],
    updated: "2026-10-10",
  },
];

export const USE_CASE_BY_SLUG = new Map(USE_CASES.map((u) => [u.slug, u]));
