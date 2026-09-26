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
