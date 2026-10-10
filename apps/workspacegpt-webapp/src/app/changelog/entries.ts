import type { IconName } from "../_components/Icon";

/**
 * What shipped, newest first. /changelog renders all of it; the home page's
 * "What's new" strip reads the first few entries, so a release only has to be
 * written down here once.
 *
 * Write what a user can now do, not what the diff did. Versions are the tags
 * that shipped it (desktop-v*, workspaceGPT-v*, and the Chrome Web Store
 * version of apps/chrome-extension).
 */

export type Product = "Desktop" | "Extension" | "Chrome extension";

export type ChangelogItem = {
  icon: IconName;
  title: string;
  body: string;
};

export type ChangelogEntry = {
  /** ISO date the release was tagged. */
  date: string;
  releases: { product: Product; version: string }[];
  title: string;
  summary: string;
  items: ChangelogItem[];
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-10-10",
    releases: [{ product: "Desktop", version: "0.0.22–0.0.27" }],
    title: "A home for your work, and CI that fixes itself",
    summary:
      "The desktop app now separates chatting from ticket work, and can watch your pull request's checks for you.",
    items: [
      {
        icon: "clipboard-list",
        title: "Chat and Work modes",
        body: "Switch the Sessions panel between Chat and Work. Work groups your sessions by the folder they ran in and opens on a compact home with your tickets and recent activity.",
      },
      {
        icon: "git-pull-request",
        title: "CI monitoring and auto-fix",
        body: "After a pull request is opened, WorkspaceGPT reads its checks and can start a session to fix a failing one. You decide whether it pushes.",
      },
      {
        icon: "sliders",
        title: "Resizable sidebar and zoom",
        body: "Drag the sidebar to the width you like, and zoom the whole app in or out. Settings no longer jump around when you switch pages.",
      },
      {
        icon: "sparkles",
        title: "Simpler first run",
        body: "Onboarding offers clearer setup options, and the Knowledge sources you haven't connected show a Connect button instead of hiding.",
      },
    ],
  },
  {
    date: "2026-10-07",
    releases: [{ product: "Desktop", version: "0.0.14–0.0.21" }],
    title: "You choose how much the agent may do",
    summary:
      "A permission dial, a built-in terminal, and your existing chats brought across from other tools.",
    items: [
      {
        icon: "shield-check",
        title: "Plan, Manual, Auto or Full access",
        body: "One dial above the composer sets what the agent may do without asking. Plan can't write at all, and “Run plan” carries a plan out in Agent mode. Manual asks before every change, Auto asks only for risky ones, and Full access, shown in red, asks for nothing.",
      },
      {
        icon: "terminal",
        title: "Integrated terminal",
        body: "A terminal panel sits next to the conversation. Commands in code blocks have a Run button, and long-running jobs the agent starts keep going in the background.",
      },
      {
        icon: "download",
        title: "Import chats from Claude Code and Cursor",
        body: "Bring your earlier conversations in. Chats from Claude Code worktrees are filed under their own repository.",
      },
      {
        icon: "folder",
        title: "Each chat works in its own folder",
        body: "A session keeps the folder it started in, even if you open a different one later. The Sessions list pages 20 at a time, and a right-click menu opens, pins, renames, groups or deletes a chat.",
      },
      {
        icon: "arrow-right",
        title: "Every run ends with a next step",
        body: "When the agent finishes it either does the next step, offers it as a question, or lists what's left, so you're never left guessing.",
      },
      {
        icon: "globe",
        title: "Connectors, themes and browser fixes",
        body: "A Connectors page manages Control Chrome. Light and dark themes are remembered across launches, agent tabs open in your own Chrome window, and editing a message keeps its attachments.",
      },
    ],
  },
  {
    date: "2026-09-30",
    releases: [{ product: "Desktop", version: "0.0.9–0.0.13" }],
    title: "Spike tickets become researched docs",
    summary:
      "Research tickets get a written answer, and Confluence edits are reviewed in one go.",
    items: [
      {
        icon: "file-text",
        title: "Spikes research, write and publish",
        body: "On a spike, the agent searches every connected source, writes its findings to a markdown file in docs/spikes, lists its references, and offers a Publish to Confluence button.",
      },
      {
        icon: "message-square",
        title: "It asks when it needs you",
        body: "Open questions appear as a card you can answer, instead of the agent guessing and carrying on.",
      },
      {
        icon: "pen",
        title: "One review for several Confluence edits",
        body: "Section edits to the same page are batched into a single diff, and pasted edit links are recognised.",
      },
      {
        icon: "folder",
        title: "A default folder for ticket work",
        body: "Pick where ticket work happens once. A popup confirms when a task would switch folders, and the title bar shows the folder.",
      },
      {
        icon: "plug",
        title: "Copilot prompt caching",
        body: "GitHub Copilot runs reuse cached prompts, count one request per action, and have an effort picker.",
      },
    ],
  },
  {
    date: "2026-09-28",
    releases: [
      { product: "Desktop", version: "0.0.8" },
      { product: "Extension", version: "2.0.45" },
    ],
    title: "Bring your GitHub Copilot plan",
    summary:
      "No API key needed: WorkspaceGPT can run on the Copilot subscription you already pay for.",
    items: [
      {
        icon: "plug",
        title: "GitHub Copilot in VS Code",
        body: "Open Settings → Model and, under “Use a subscription”, pick GitHub Copilot. WorkspaceGPT goes through VS Code's own Language Model API, so it uses the Copilot plan you're signed in to. VS Code asks once to allow it, and requests count toward your Copilot usage. Only models with enough room for an agent run are listed.",
      },
      {
        icon: "alert",
        title: "GitHub Copilot on the desktop (unofficial)",
        body: "GitHub doesn't offer Copilot to desktop apps, so the desktop app signs in the way LiteLLM does: as VS Code's Copilot client. It's off until you click Connect and accept a warning. It can stop working at any time, heavy use can get your Copilot access warned or suspended, and your organization's Copilot policy may not allow it. Sign out from the same card.",
      },
      {
        icon: "pen",
        title: "Confluence editing in the extension",
        body: "Editing and creating Confluence pages, first shipped in Desktop 0.0.6, now works in the VS Code extension too. Reconnect Confluence once to give it edit access.",
      },
    ],
  },
  {
    date: "2026-09-26",
    releases: [
      { product: "Desktop", version: "0.0.6" },
      { product: "Chrome extension", version: "0.3.0" },
    ],
    title: "It writes to Confluence and uses your browser",
    summary:
      "The agent can now update the docs it reads, and check its work in the Chrome you already use every day.",
    items: [
      {
        icon: "pen",
        title: "Edit and create Confluence pages",
        body: "The agent rewrites one section of a page, or drafts a new page wherever you choose, and shows the change as a diff before anything is saved. Macros, mentions and images outside that section are left exactly as they were, and the page history is your undo. New pages start as drafts unless you ask to publish. Reconnect Confluence once to give it edit access.",
      },
      {
        icon: "file-text",
        title: "Pasted page links keep their structure",
        body: "Paste a Confluence link and the agent reads the page as markdown, with headings, tables, panels and code blocks intact instead of flattened into plain text.",
      },
      {
        icon: "globe",
        title: "Browser control",
        body: "With the WorkspaceGPT Chrome extension, the agent opens tabs, navigates, clicks, types, fills forms, scrolls and drags. It can also read the page, the console and network requests, and take screenshots. It uses the sites you're already signed in to, acts only in its own “WorkspaceGPT” tab group or the tab you're looking at, and won't type into password fields. macOS for now.",
      },
      {
        icon: "folder",
        title: "Sessions follow Chat and Work",
        body: "The Sessions list shows only the mode you're in. Chat sessions are listed by date. Work sessions are grouped by project folder, with a + on the folder that's open.",
      },
    ],
  },
  {
    date: "2026-09-25",
    releases: [
      { product: "Desktop", version: "0.0.5" },
      { product: "Chrome extension", version: "0.2.0" },
    ],
    title: "The agent can see your browser",
    summary: "The first step toward browser control: read-only access to your own Chrome profile.",
    items: [
      {
        icon: "globe",
        title: "Read your tabs, only with your OK",
        body: "Turn on “Let WorkspaceGPT use this browser” in the Chrome extension, and the desktop agent can list your tabs, read a page and take a screenshot, including pages behind your company's single sign-on. It stays off until you turn it on.",
      },
    ],
  },
  {
    date: "2026-09-25",
    releases: [
      { product: "Desktop", version: "0.0.4" },
      { product: "Extension", version: "2.0.44" },
    ],
    title: "Knowledge syncs you can see and stop",
    summary: "Syncs that run in the background now behave like the ones you start yourself.",
    items: [
      {
        icon: "refresh",
        title: "Background syncs show up",
        body: "A scheduled sync, or one resumed after a restart, shows its live progress under Settings → Knowledge, and Stop actually stops it.",
      },
      {
        icon: "database",
        title: "A finished index is used right away",
        body: "When a background sync finishes indexing, chat starts searching it immediately. Before this fix, an index built in the background could go unused.",
      },
      {
        icon: "clock",
        title: "Interrupted indexing resumes",
        body: "Quit in the middle of a sync and indexing picks up where it stopped the next time you open the app. This now works on Desktop too.",
      },
      {
        icon: "terminal",
        title: "Mac installer fix",
        body: "The one-line macOS installer no longer fails with “unbound variable” in a UTF-8 Terminal. Every release is now test-installed from the public download links.",
      },
    ],
  },
  {
    date: "2026-09-25",
    releases: [{ product: "Desktop", version: "0.0.3" }],
    title: "WorkspaceGPT Desktop on Windows",
    summary: "The desktop app, now on Windows x64.",
    items: [
      {
        icon: "laptop",
        title: "One line in PowerShell",
        body: "It checks the installer's SHA-256 and installs for your user only, with no admin prompt. It updates itself the same way the Mac app does.",
      },
      {
        icon: "lock",
        title: "Credential Manager",
        body: "Tokens and keys are stored in Windows Credential Manager, never in a settings file.",
      },
      {
        icon: "shield-check",
        title: "Nothing left running",
        body: "Quitting the app ends every command the agent started, even if the app is force-closed.",
      },
    ],
  },
  {
    date: "2026-09-25",
    releases: [
      { product: "Desktop", version: "0.0.1" },
      { product: "Desktop", version: "0.0.2" },
    ],
    title: "WorkspaceGPT Desktop for macOS",
    summary: "The same agent, with no editor required.",
    items: [
      {
        icon: "laptop",
        title: "A standalone app",
        body: "Open a folder and the agent reads, edits and tests it, with your Knowledge in reach. Runs on Apple Silicon and Intel Macs with macOS 12 or later.",
      },
      {
        icon: "search",
        title: "A built-in language server",
        body: "Symbol, definition and reference lookups plus diagnostics, all bundled. It shuts down after five idle minutes to free the memory.",
      },
      {
        icon: "refresh",
        title: "Signed updates",
        body: "Updates download in the background and are signature-checked. They install when you quit, or right away if you choose Restart Now.",
      },
      {
        icon: "bell",
        title: "Notifications",
        body: "When the window isn't in front, a banner and a Dock badge tell you a run needs your review, has finished, or has failed.",
      },
    ],
  },
  {
    date: "2026-09-22",
    releases: [{ product: "Extension", version: "2.0.42" }],
    title: "Chat or Work",
    summary: "One switch decides whether a conversation uses your org's knowledge.",
    items: [
      {
        icon: "message-square",
        title: "Chat and Work modes",
        body: "Work grounds answers in your Confluence, Azure DevOps and the open codebase. Chat is a plain conversation that leaves them out. Each mode keeps its own history.",
      },
      {
        icon: "zap",
        title: "Credits on every answer",
        body: "In Remote mode, each answer shows an estimate of the credits it used.",
      },
    ],
  },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-26" → "Sep 26, 2026", without a timezone shifting the day. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function releaseLabel(r: { product: Product; version: string }): string {
  return `${r.product} ${r.version}`;
}

/** Stable anchor for an entry, from the first release it names: "desktop-0.0.6". */
export function entryAnchor(entry: ChangelogEntry): string {
  const r = entry.releases[0];
  return `${r.product}-${r.version}`.toLowerCase().replace(/[^a-z0-9.]+/g, "-");
}
