# SEO launch kit — paste-ready text

Companion to the on-site SEO work (use-case pages, sitemap, JSON-LD, llms.txt).
Every claim below is one the website already makes. Section 2 was
rewritten for extension 0.4.0 — still check it against what the extension does on the day you submit.

## 1. GitHub repo (About box) — DONE 2026-10-10 (applied via the owner Chrome profile)

The signed-in accounts in Chrome and `gh` (`ritesh-kant_mars`, `riteshkantsitora`)
only have READ on the repo, so this has to be done as the owner.

- **Description**
  > The coding agent that knows your whole org. Reads Confluence, Jira and Azure DevOps mid-task, edits and verifies your code. Zero data retention. VS Code, Cursor, Antigravity, macOS and Windows.
- **Website:** `https://www.workspacegpt.in` — it currently points at
  `workspace-gpt-workspacegpt-webapp.vercel.app`, which is why Google lists a
  vercel.app URL as the referrer for `/docs`.
- **Topics:** `ai-coding-agent`, `coding-agent`, `confluence`, `jira`,
  `azure-devops`, `vscode-extension`, `cursor`, `ollama`, `mcp`,
  `retrieval-augmented-generation`, `developer-tools`, `privacy`

Or, as the owner: `gh repo edit ritesh-kant/workspaceGPT --description "…" --homepage https://www.workspacegpt.in --add-topic ai-coding-agent …`

## 2. Chrome Web Store listing — needs a Google re-verify (for extension 0.4.0)

Dashboard: https://chrome.google.com/webstore/devconsole (asks for the password again).
Upload `apps/chrome-extension/release/workspacegpt-chrome-0.4.0.zip`, then fill in:

Copy below describes 0.4.0: the panel only talks to WorkspaceGPT Desktop (no keys,
no Gemini/Qdrant), reads but never changes the open page, and keeps its history in
the browser. Re-check it if that changes.

- **Summary (max 132 chars):**
  > Ask your Confluence, Jira and Azure DevOps Knowledge from a side panel — answers from WorkspaceGPT Desktop, on your machine.
- **Description:**
  > WorkspaceGPT is a coding agent that reads your Confluence pages, Jira issues and Azure DevOps work items mid-task, edits and verifies your code, and can update the docs afterwards. Your documents and search index stay on your machine, and nothing is retained on our side.
  >
  > This extension is the Chrome side panel for WorkspaceGPT Desktop. Ask questions about your Knowledge without leaving the tab you are on. The page you are reading can be included as context — it is only ever read, never changed — and you can remove it with one click. Your conversations are saved in your browser. There are no API keys in the browser: answers come from the model you set up in the desktop app.
  >
  > Requires WorkspaceGPT Desktop (the browser connection works on macOS and Linux today): https://www.workspacegpt.in
- **Website / Support URL:** `https://www.workspacegpt.in` and `https://www.workspacegpt.in/support`.
- **Screenshots (1280x800) and small tile (440x280):** `apps/chrome-extension/store/images/`
  (regenerate with `node apps/chrome-extension/store/render.mjs` after `pnpm build`).
- **Permission justifications** (the console asks for one per permission):
  - `sidePanel` — shows the WorkspaceGPT panel beside the page.
  - `storage` — keeps the on/off setting, connection status and the user's saved conversations in their own browser.
  - `alarms` — retries the connection to WorkspaceGPT Desktop when it is started after the browser.
  - `nativeMessaging` — the only channel to WorkspaceGPT Desktop on the user's own machine; questions and answers go through it and nowhere else.
  - `scripting` and host access (`<all_urls>`) — read the text of the tab the user has open, at their request, so a question can be about that page. Pages are read, not changed, from the side panel.
  - `debugger` and `tabGroups` — the desktop agent's optional browser control (open, click, type in its own tab group), which the user can switch off in Settings. It acts in the tab group it opens or the tab the user is looking at; Chrome shows its own "debugging this browser" bar while it does.
- **Single purpose:** answer questions about the user's own Knowledge (Confluence, Jira, Azure DevOps) in a browser side panel, using WorkspaceGPT Desktop.
- **Data use:** no remote code; page text and questions go only to WorkspaceGPT Desktop on the same computer (not to any WorkspaceGPT server). Match this against `/privacy` before submitting.

## 3. VS Code Marketplace / Open VSX

The Marketplace page is generated from the extension's `package.json` and README,
so it only changes on the next extension release. Put in that release:
`"homepage": "https://www.workspacegpt.in"`, `"repository"`, `"bugs"` and a first-paragraph
README link to `https://www.workspacegpt.in/use-cases/confluence-ai-coding-agent`.

## 4. Bing Webmaster Tools — DONE 2026-10-10 (sitemap submitted + 6 URLs via URL Submission; the Bing property is the apex `workspacegpt.in`, recheck sitemap status in a few days)

https://www.bing.com/webmasters → Sign in → **Import from Google Search Console**
(property `workspacegpt.in` is already verified there) → Bing then pulls the
sitemap automatically.

## 5. Launch posts — drafts only, post them yourself

Don't post all four on the same day, and don't cross-post identical text.

### Show HN
**Title:** Show HN: WorkspaceGPT – a coding agent that reads your Confluence/Jira/ADO and stores nothing

> I built WorkspaceGPT because most coding agents start from your repo and a prompt,
> but the reason code is built a certain way is usually in a Confluence page or a work
> item. It syncs Confluence, Jira and Azure DevOps, indexes them on your machine
> (embeddings are on-device, the index is local files), and the agent searches them
> mid-task alongside your code, cites what it used, runs your linter/type-checker/tests
> and can propose the Confluence edit when the docs are stale.
>
> Local mode runs fully offline with Ollama (or your Copilot plan / own key). Remote mode
> (preview) is a managed model: only the question and retrieved snippets reach the
> endpoint, in memory, nothing stored.
>
> VS Code / Cursor / Antigravity extension, plus a desktop app for macOS and Windows.
> https://www.workspacegpt.in — I'd especially like feedback on the privacy model.

### Product Hunt
- **Name:** WorkspaceGPT
- **Tagline (60):** The coding agent that knows your whole org
- **Description (260):** Reads Confluence, Jira and Azure DevOps mid-task, edits and verifies your code, and can update the docs afterwards. Indexed on your machine, zero data retention. VS Code, Cursor, Antigravity, macOS and Windows.

### Reddit (r/vscode or r/ExperiencedDevs — read each sub's self-promo rules first)
**Title:** I built a coding agent that reads the Confluence page and ticket behind the task, and keeps the index on your machine

> Copy-pasting a ticket into a chat loses the acceptance criteria and the design page it
> assumes you've read. [one honest paragraph on how it works + the offline Ollama option]
> It's free in Local mode. Happy to answer questions about the on-device indexing.
> https://www.workspacegpt.in

### devnotes.tech post (outline)
Title: "Why your coding agent should start from the ticket, not the repo."
1. The problem: context lives in Confluence/Jira/ADO, not the repo.
2. How on-device indexing works and why that matters for security review.
3. A worked example (ticket → design page → fix → tests → Confluence edit).
4. Links to the four use-case pages:
   `/use-cases/confluence-ai-coding-agent`, `/azure-devops-ai-coding-agent`,
   `/jira-ai-coding-agent`, `/private-ai-coding-agent` (all under https://www.workspacegpt.in).
