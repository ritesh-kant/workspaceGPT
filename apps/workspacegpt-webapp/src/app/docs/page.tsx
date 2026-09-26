"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "../_components/Icon";
import { SiteNav } from "../_components/SiteNav";
import { SiteFooter } from "../_components/SiteFooter";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "installation", label: "Installation" },
  { id: "modes", label: "Modes & Privacy" },
  { id: "ai-providers", label: "AI Providers" },
  { id: "codebase", label: "Codebase Exploration" },
  { id: "work-modes", label: "Chat, Work & Autonomy" },
  { id: "embeddings", label: "Embeddings & Vector Storage" },
  { id: "confluence", label: "Confluence" },
  { id: "jira", label: "Jira" },
  { id: "ado", label: "Azure DevOps" },
  { id: "browser", label: "Browser Control" },
  { id: "deployment", label: "Deployment Automation" },
  { id: "mcp", label: "MCP Server" },
  { id: "commands", label: "Commands & Shortcuts" },
  { id: "reset", label: "Reset & Clear Data" },
  { id: "troubleshooting", label: "Troubleshooting" },
];

function SectionAnchor({ id }: { id: string }) {
  return <div id={id} className="-mt-20 pt-20" />;
}

function Badge({ children, color = "brand" }: { children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    brand: "bg-brand/10 text-brand border-brand/20",
    blue: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    purple: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    yellow: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    red: "bg-red-500/10 text-red-400 border-red-500/20",
    green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[color] ?? colors.brand}`}>
      {children}
    </span>
  );
}

function CodeBlock({ children, language = "bash" }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group rounded-xl bg-background border border-line overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 border-b border-line bg-surface-2">
        <span className="text-xs text-faint font-mono">{language}</span>
        <button onClick={copy} className="text-xs text-faint hover:text-white transition-colors">
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="px-4 py-4 overflow-x-auto text-sm text-brand-blue font-mono leading-relaxed whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-5">
      <div className="flex-shrink-0 flex items-start pt-0.5">
        <div className="w-8 h-8 rounded-full bg-brand/20 border border-brand/30 text-brand font-bold text-sm flex items-center justify-center">
          {number}
        </div>
      </div>
      <div className="flex-1 pb-8">
        <h4 className="text-white font-semibold text-base mb-2">{title}</h4>
        <div className="text-muted text-sm leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

function Card({ title, icon, children, accent = "brand" }: { title: string; icon: IconName; children: React.ReactNode; accent?: string }) {
  const accents: Record<string, string> = {
    brand: "hover:border-brand/40",
    blue: "hover:border-blue-500/40",
    purple: "hover:border-purple-500/40",
    green: "hover:border-emerald-500/40",
  };
  const tones: Record<string, string> = {
    brand: "text-brand",
    blue: "text-blue-400",
    purple: "text-purple-400",
    green: "text-emerald-400",
  };
  return (
    <div className={`bg-surface border border-line rounded-xl p-6 ${accents[accent] ?? accents.brand} transition-colors duration-300`}>
      <div className="flex items-center gap-3 mb-3">
        <span className={tones[accent] ?? tones.brand}><Icon name={icon} size={18} /></span>
        <h4 className="text-white font-semibold">{title}</h4>
      </div>
      <div className="text-muted text-sm leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl sm:text-3xl font-semibold text-white mb-2 tracking-tight">{children}</h2>
  );
}

function SectionSubtitle({ children }: { children: React.ReactNode }) {
  return <p className="text-muted mb-8 text-base">{children}</p>;
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("overview");

  // Scroll-spy: the sidebar marks the section being read, not just the last
  // one clicked, so arriving from a /docs#… link or scrolling keeps it right.
  useEffect(() => {
    const onScroll = () => {
      let current = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 140) current = s.id;
      }
      setActiveSection(current);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <SiteNav />

      <div className="container mx-auto px-4 sm:px-6 flex gap-0 lg:gap-10 flex-1">
        {/* Sidebar */}
        <aside className="hidden lg:block w-56 xl:w-64 flex-shrink-0 py-10">
          <div className="sticky top-24 space-y-1">
            <p className="text-xs font-semibold text-faint uppercase tracking-wider mb-4 px-3">On this page</p>
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setActiveSection(s.id)}
                className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeSection === s.id
                    ? "bg-brand/10 text-brand font-medium"
                    : "text-muted hover:text-white hover:bg-white/5"
                }`}
              >
                {s.label}
              </a>
            ))}
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 py-10 min-w-0 max-w-3xl">

          {/* ── Overview ─────────────────────────────────────── */}
          <SectionAnchor id="overview" />
          <section className="mb-16">
            <Link href="/changelog" className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand text-xs font-medium mb-6 hover:bg-brand/15 transition-colors">
              <span className="relative inline-flex rounded-full h-2 w-2 bg-brand" />
              New: Confluence page editing and browser control
              <Icon name="arrow-right" size={12} />
            </Link>
            <SectionTitle>WorkspaceGPT Docs</SectionTitle>
            <SectionSubtitle>
              Everything you need to install, configure, and get the most out of WorkspaceGPT &mdash; in VS Code, Cursor or Antigravity, or as the WorkspaceGPT Desktop app on macOS or Windows.
            </SectionSubtitle>

            <div className="grid sm:grid-cols-3 gap-4">
              <Card icon="lock" title="Privacy-First" accent="green">
                <p>Indexing and embeddings run on-device and the vector index stays in local files — in <em>both</em> modes. We retain nothing.</p>
              </Card>
              <Card icon="sparkles" title="Agentic" accent="brand">
                <p>Reads and edits your code, then runs your checks to verify it. Retrieval over your Confluence docs and Jira and Azure DevOps tickets supplies the &ldquo;why&rdquo;.</p>
              </Card>
              <Card icon="zap" title="Zero Setup" accent="blue">
                <p>Install from the marketplace and start chatting in under 2 minutes.</p>
              </Card>
            </div>
          </section>

          {/* ── Installation ─────────────────────────────────── */}
          <SectionAnchor id="installation" />
          <section className="mb-16">
            <SectionTitle>Installation</SectionTitle>
            <SectionSubtitle>Available in the VS Code and Cursor marketplaces, on Open VSX for Antigravity, and as a desktop app for macOS and Windows.</SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Via Extensions Marketplace">
                <p>Open VS Code, Cursor, or Antigravity and navigate to the Extensions view:</p>
                <p>
                  <kbd className="bg-white/10 text-foreground px-2 py-0.5 rounded text-xs font-mono">Ctrl+Shift+X</kbd>
                  {" "}&nbsp;or{" "}&nbsp;
                  <kbd className="bg-white/10 text-foreground px-2 py-0.5 rounded text-xs font-mono">Cmd+Shift+X</kbd>
                  {" "}on macOS
                </p>
                <p>Search for <strong className="text-white">WorkspaceGPT</strong> and click <strong className="text-white">Install</strong>.</p>
              </Step>

              <Step number={2} title="Via Command Palette">
                <p>Press <kbd className="bg-white/10 text-foreground px-2 py-0.5 rounded text-xs font-mono">Ctrl+P</kbd> to open Quick Open and run:</p>
                <CodeBlock language="bash">ext install Riteshkant.workspacegpt-extension</CodeBlock>
              </Step>

              <Step number={3} title="Via Marketplace Website">
                <p>
                  Visit the{" "}
                  <a href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    VS Code Marketplace page
                  </a>{" "}
                  and click <strong className="text-white">Install</strong>.
                </p>
              </Step>

              <Step number={4} title="On Antigravity (or other VS Code forks)">
                <p>
                  Antigravity, Windsurf, and VSCodium install from{" "}
                  <a href="https://open-vsx.org/extension/Riteshkant/workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    Open VSX
                  </a>{" "}
                  instead of the Microsoft Marketplace. Search <strong className="text-white">WorkspaceGPT</strong> in the Extensions view, or open the Open VSX page and click <strong className="text-white">Download</strong>.
                </p>
              </Step>

              <Step number={5} title="WorkspaceGPT Desktop (macOS and Windows, no editor needed)">
                <p>The same agent as a standalone app. On a Mac (Apple Silicon or Intel, macOS 12 or later), paste this into Terminal:</p>
                <CodeBlock language="bash">curl -fsSL https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.sh | sh</CodeBlock>
                <p>
                  The installer downloads the build for your Mac, checks its SHA-256 against the release, and installs it into{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">/Applications</code>. Prefer a DMG or setup.exe? Download it from the{" "}
                  <a href="https://github.com/ritesh-kant/workspaceGPT/releases?q=desktop-v&amp;expanded=true" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    GitHub releases
                  </a>
                  . The app isn&apos;t notarized yet, so a DMG copy needs one <strong className="text-white">Open Anyway</strong> in System Settings → Privacy &amp; Security the first time; the Terminal installer doesn&apos;t.
                </p>
                <p className="text-muted">
                  Desktop updates itself: it checks for a new version in the background, verifies its signature, and installs it the next time you quit or when you choose <strong className="text-white">Restart Now</strong>. Secrets live in the macOS Keychain (or Windows Credential Manager). When its window isn&apos;t in front, Desktop sends a notification when a run needs your review, finishes or fails.
                </p>
                <p>On Windows (x64), paste this into PowerShell:</p>
                <CodeBlock language="powershell">irm https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.ps1 | iex</CodeBlock>
                <p>
                  It checks the installer&apos;s SHA-256 and installs for your user only &mdash; no admin prompt. The installer isn&apos;t
                  code-signed yet: this PowerShell line isn&apos;t stopped by SmartScreen, but a <code className="bg-white/10 px-1 rounded text-xs">-setup.exe</code> downloaded
                  in a browser shows &ldquo;Windows protected your PC&rdquo; &mdash; choose <strong className="text-white">More info → Run anyway</strong>. Linux builds are not available yet.
                </p>
              </Step>
            </div>

            <div className="bg-surface border border-line rounded-xl p-5 mt-2">
              <p className="text-sm text-muted">
                <span className="text-brand font-semibold">Minimum VS Code version:</span> 1.98.0. WorkspaceGPT activates when you open its sidebar, so it costs you nothing until you use it.
              </p>
            </div>
          </section>

          {/* ── Modes & Privacy ──────────────────────────────── */}
          <SectionAnchor id="modes" />
          <section className="mb-16">
            <SectionTitle>Modes &amp; Privacy</SectionTitle>
            <SectionSubtitle>
              WorkspaceGPT has exactly one mode switch, under{" "}
              <code className="bg-white/10 px-1 rounded text-xs">Settings → Mode</code>. It changes where
              answers are generated &mdash; nothing else.
            </SectionSubtitle>

            <div className="p-5 bg-surface border border-emerald-500/20 rounded-xl text-sm text-muted mb-8">
              <span className="text-emerald-400 font-semibold">Your index never moves.</span> Embeddings are
              generated on-device and the vector index is written to local files inside the extension&apos;s
              storage, in <strong className="text-white">both</strong> modes. Switching modes never uploads
              anything and never requires a re-index.
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mb-8">
              <Card icon="lock" title="Local" accent="green">
                <p>Everything runs on your machine: the chat model, the embeddings, the index, the retrieval.</p>
                <p>Use Ollama for a fully offline setup, or supply your own key for OpenAI, Claude, Gemini, Groq, OpenRouter, NVIDIA, or any OpenAI-compatible endpoint. No WorkspaceGPT account needed.</p>
              </Card>
              <Card icon="zap" title="Remote" accent="brand">
                <div className="mb-2"><Badge color="brand">Preview</Badge></div>
                <p>We run the inference infrastructure and pick the model, so there is no provider key to buy and nothing to configure.</p>
                <p>Sign in with GitHub once. Your question and the snippets retrieved for it are sent to our endpoint per request; your documents, code and index stay on your machine.</p>
              </Card>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">What each mode sends</h3>
            <div className="overflow-x-auto rounded-xl border border-line mb-8">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface">
                    <th className="text-left px-5 py-3 text-muted font-semibold">&nbsp;</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Local</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Remote</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    ["Documents, code, work items", "Never leave your machine", "Never leave your machine"],
                    ["Embeddings", "Generated on-device", "Generated on-device"],
                    ["Vector index", "Local files", "Local files"],
                    ["Question + retrieved snippets", "To your chosen provider, or nowhere with Ollama", "To our endpoint, then the upstream model"],
                    ["Account", "None", "GitHub sign-in, verified per request"],
                    ["Model keys you supply", "Yours, or none with Ollama", "None"],
                    ["Stored by WorkspaceGPT", "Nothing", "Nothing but your account row"],
                  ].map(([label, local, remote]) => (
                    <tr key={label} className="bg-background align-top">
                      <td className="px-5 py-3 font-medium text-white">{label}</td>
                      <td className="px-5 py-3 text-muted">{local}</td>
                      <td className="px-5 py-3 text-muted">{remote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">Zero data retention</h3>
            <p className="text-muted text-sm leading-relaxed mb-4">
              In Remote mode your request is held in memory only for as long as it takes to stream the answer
              back, then discarded. We do not write prompts, answers, or retrieved snippets to any database, any
              file, or any log &mdash; our servers log status codes and error types only. The entirety of what we
              store per account is: your GitHub id and handle, your plan and status, an opaque session token that
              expires in 30 days, and how many credits you have used this week.
            </p>
            <p className="text-muted text-sm leading-relaxed mb-8">
              Generation itself is performed by an upstream model provider (currently OpenRouter) under its own
              policy. If you need a guarantee that covers the whole path contractually, use Local mode with
              Ollama &mdash; no third party is involved at all. Full detail in the{" "}
              <Link href="/privacy" className="text-brand hover:underline">privacy policy</Link>.
            </p>

            <div className="p-5 bg-surface border border-yellow-500/20 rounded-xl text-sm text-muted">
              <span className="text-yellow-400 font-semibold">Remote mode is in preview.</span> It is rolling out
              now, and models, limits and behaviour may change while we tune it. Local mode is generally
              available and unaffected. Remote mode gives each account a weekly allowance of credits, metered by model tokens (one credit is about 1,000 tokens); you can see this week&apos;s usage and when it resets under <code className="bg-white/10 px-1 rounded text-xs">Settings → Account</code>.
            </div>
          </section>

          {/* ── AI Providers ─────────────────────────────────── */}
          <SectionAnchor id="ai-providers" />
          <section className="mb-16">
            <SectionTitle>AI Providers</SectionTitle>
            <SectionSubtitle>
              These apply to <strong className="text-white">Local mode</strong>, where you bring your own model.
              In Remote mode there is no provider to choose &mdash; we run the model for you (see{" "}
              <a href="#modes" className="text-brand hover:underline">Modes &amp; Privacy</a>).
            </SectionSubtitle>

            <div className="overflow-x-auto rounded-xl border border-line mb-8">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface">
                    <th className="text-left px-5 py-3 text-muted font-semibold">Provider</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Privacy</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Requires API Key</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    { name: "Ollama", privacy: "100% Local", key: "No", note: "Default. Run llama3.2:1b or any local model.", badge: "green" },
                    { name: "OpenAI", privacy: "Cloud", key: "Yes", note: "GPT-4o, GPT-4-turbo, GPT-3.5 etc.", badge: "blue" },
                    { name: "Gemini", privacy: "Cloud", key: "Yes", note: "Google's Gemini Pro/Flash models.", badge: "blue" },
                    { name: "Groq", privacy: "Cloud", key: "Yes", note: "High-speed inference on Llama / Mixtral.", badge: "purple" },
                    { name: "OpenRouter", privacy: "Cloud", key: "Yes", note: "Access 100+ models via one API key.", badge: "purple" },
                    { name: "Claude", privacy: "Cloud", key: "Yes", note: "Anthropic's Claude models.", badge: "blue" },
                    { name: "NVIDIA", privacy: "Cloud", key: "Yes", note: "Models hosted on NVIDIA's API catalog.", badge: "purple" },
                    { name: "Requesty", privacy: "Cloud", key: "Yes", note: "LLM router with one key for many providers.", badge: "yellow" },
                    { name: "Custom", privacy: "You decide", key: "Yes", note: "Any OpenAI-compatible endpoint: self-hosted, proxy or gateway.", badge: "yellow" },
                  ].map((row) => (
                    <tr key={row.name} className="bg-background hover:bg-surface-2 transition-colors">
                      <td className="px-5 py-3 font-medium text-white">{row.name}</td>
                      <td className="px-5 py-3"><Badge color={row.badge}>{row.privacy}</Badge></td>
                      <td className="px-5 py-3 text-muted">{row.key}</td>
                      <td className="px-5 py-3 text-muted">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">Configuring Ollama (Recommended)</h3>
            <div className="space-y-0">
              <Step number={1} title="Install Ollama">
                <p>Download from <a href="https://ollama.com" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">ollama.com</a> and follow the installer for your OS.</p>
              </Step>
              <Step number={2} title="Pull a model">
                <CodeBlock language="bash">ollama pull llama3.2:1b</CodeBlock>
                <p className="text-muted">For better responses, try a larger model:</p>
                <CodeBlock language="bash">{`ollama pull llama3.2:4b
# or
ollama pull gemma3:4b
# or
ollama pull mistral`}</CodeBlock>
              </Step>
              <Step number={3} title="Select in WorkspaceGPT">
                <p>Open the WorkspaceGPT sidebar → <code className="bg-white/10 px-1 rounded text-xs">Settings → Providers → Ollama</code>. Your locally running models will appear automatically.</p>
              </Step>
            </div>

            <h3 className="text-lg font-semibold text-white mt-8 mb-4">Configuring Cloud Providers</h3>
            <p className="text-muted text-sm mb-4">Open <code className="bg-white/10 px-1 rounded text-xs">Settings → Providers</code>, select your provider, and paste your API key. Keys are stored securely in VS Code&apos;s secret storage and never logged.</p>
          </section>

          {/* ── Codebase ──────────────────────────────────────── */}
          <SectionAnchor id="codebase" />
          <section className="mb-16">
            <SectionTitle>Codebase Exploration</SectionTitle>
            <SectionSubtitle>
              WorkspaceGPT explores the folder currently open in your editor with live search, file reads, and language-server navigation.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Open a workspace folder">
                <p>Open the repository you want to discuss in VS Code, Cursor, or Antigravity.</p>
              </Step>
              <Step number={2} title="Ask about the code">
                <p>Ask a question in WorkspaceGPT. The agent searches and reads relevant files as it works, and can follow symbols and references through your editor&apos;s language service.</p>
              </Step>
              <Step number={3} title="Review cited findings">
                <p>Use the returned file references to inspect the live workspace context behind the answer.</p>
              </Step>
            </div>

            <div className="mt-4 p-5 bg-surface border border-yellow-500/20 rounded-xl text-sm text-muted">
              <span className="text-yellow-400 font-semibold">Note:</span> Codebase exploration does not create embeddings or a persistent index of your workspace. Availability depends on having a folder open in the current editor window.
            </div>
          </section>

          {/* ── Chat, Work & Autonomy ─────────────────────────── */}
          <SectionAnchor id="work-modes" />
          <section className="mb-16">
            <SectionTitle>Chat, Work &amp; Autonomy</SectionTitle>
            <SectionSubtitle>
              Two switches in the composer decide what a conversation can reach and how much the agent does without asking.
            </SectionSubtitle>

            <h3 className="text-lg font-semibold text-white mb-4">Chat or Work</h3>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              <Card icon="clipboard-list" title="Work" accent="brand">
                <p>Answers draw on your Confluence, Jira and Azure DevOps knowledge and the open codebase, and the agent can edit files and run commands. This is the default.</p>
              </Card>
              <Card icon="message-square" title="Chat" accent="blue">
                <p>A plain conversation with the model. Your knowledge and the codebase aren&apos;t consulted, and nothing is edited.</p>
              </Card>
            </div>
            <p className="text-muted text-sm leading-relaxed mb-8">
              Pick one before the first message; a conversation keeps the mode it started in. Each mode has its own
              history, and the Sessions list follows the switch: Chat sessions are listed by date, and Work sessions are
              grouped by the project folder they were started in, with <strong className="text-white">+</strong> on the
              folder that&apos;s open. Sessions from before folders were recorded appear under <em>Other</em>.
            </p>

            <h3 className="text-lg font-semibold text-white mb-4">How much it does on its own</h3>
            <p className="text-muted text-sm leading-relaxed mb-4">
              In Work mode, the chip in the composer cycles through three settings:
            </p>
            <div className="overflow-x-auto rounded-xl border border-line mb-4">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-line">
                  {[
                    ["Agent", "Default. Edits apply on their own and are checkpointed, so you can revert the whole turn. Starting a run from a ticket in Your work uses this."],
                    ["Plan", "Investigates and proposes the exact edits without changing anything. Reply “go ahead” to run the plan."],
                    ["Ask", "Every edit is shown as a diff for you to approve or reject first."],
                  ].map(([name, what]) => (
                    <tr key={name} className="bg-background align-top">
                      <td className="px-5 py-3 font-medium text-white whitespace-nowrap">{name}</td>
                      <td className="px-5 py-3 text-muted">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-muted text-sm leading-relaxed mb-8">
              Changes outside your workspace are never automatic: a Confluence edit always waits for your approval, and
              Agent-mode runs don&apos;t write to Confluence at all (see{" "}
              <a href="#confluence-write" className="text-brand hover:underline">Edit and create pages</a>).
            </p>

            <h3 className="text-lg font-semibold text-white mb-4">From ticket to pull request</h3>
            <p className="text-muted text-sm leading-relaxed">
              When a run finishes, <strong className="text-white">Create PR</strong> in the git status bar commits only
              the files the agent changed to a fresh branch, pushes it, and opens your host&apos;s new pull request page
              with the run&apos;s report filled in. That works with GitHub, Azure Repos, GitLab and Bitbucket. If the run
              came from a ticket, the report is also posted on the ticket as a comment. It uses your own{" "}
              <code className="bg-white/10 px-1 rounded text-xs">git</code> and browser session, so no token passes
              through the agent.
            </p>
          </section>

          {/* ── Embeddings & Vector Storage ──────────────────────── */}
          <SectionAnchor id="embeddings" />
          <section className="mb-16">
            <SectionTitle>Embeddings &amp; Vector Storage</SectionTitle>
            <SectionSubtitle>
              Connected Confluence, Jira and Azure DevOps sources are turned into vector embeddings so WorkspaceGPT can
              retrieve the right context. Both halves &mdash; making the embeddings and storing them &mdash; happen
              entirely on your machine, in either mode.
            </SectionSubtitle>

            <div className="p-5 bg-surface border border-emerald-500/20 rounded-xl text-sm text-muted mb-8">
              <span className="text-emerald-400 font-semibold">On-device, always.</span> Indexing is not affected by
              the Local/Remote mode switch. There is no cloud embedding provider and no hosted vector store to
              configure &mdash; and therefore no way for your content to reach us.
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">Embedding model</h3>
            <div className="overflow-x-auto rounded-xl border border-line mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface">
                    <th className="text-left px-5 py-3 text-muted font-semibold">Provider</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Model</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">API key</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Best for</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  <tr className="bg-background align-top">
                    <td className="px-5 py-3 font-medium text-white">Text <Badge color="green">Bundled</Badge></td>
                    <td className="px-5 py-3 text-muted">Xenova/all-MiniLM-L6-v2 (384-dim)</td>
                    <td className="px-5 py-3 text-muted">Not needed</td>
                    <td className="px-5 py-3 text-muted">Confluence pages, Jira issues and ADO work items. Runs on-device; first run downloads ~200&nbsp;MB.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-muted text-sm mb-8">
              Nothing to configure &mdash; the models ship with the extension and are used automatically.
            </p>

            <h3 className="text-lg font-semibold text-white mb-4">Vector storage</h3>
            <div className="mb-4">
              <Card icon="database" title="Local files, on this machine" accent="green">
                <p>Vectors are written to binary files in the extension&apos;s own storage directory. They are never uploaded, mirrored, or backed up by us.</p>
                <p>Clear them any time with <code className="bg-white/10 px-1 rounded text-xs">Settings → Reset</code> or the <strong className="text-white">Clear Data</strong> command.</p>
              </Card>
            </div>

            <div className="p-5 bg-surface border border-yellow-500/20 rounded-xl text-sm text-muted">
              <span className="text-yellow-400 font-semibold">Upgrading from an older version?</span> Earlier releases
              could store vectors in a Qdrant cluster. That option is gone &mdash; indexing is on-device only now. If
              your install used it, WorkspaceGPT tells you once on startup and you just re-sync your sources to rebuild
              the index locally.
            </div>
          </section>

          {/* ── Confluence ─────────────────────────────────────── */}
          <SectionAnchor id="confluence" />
          <section className="mb-16">
            <SectionTitle>Confluence</SectionTitle>
            <SectionSubtitle>
              Connect Confluence with one-click Atlassian sign-in. The agent searches your synced spaces mid-task, reads
              pages you paste, and can edit or create pages after you approve the change.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Open Confluence settings">
                <p>In WorkspaceGPT, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Knowledge → Confluence</code>.</p>
              </Step>
              <Step number={2} title="Sign in with Atlassian">
                <p>Click <strong className="text-white">Connect</strong>. A browser window opens Atlassian&apos;s consent screen. Sign in and grant access; no password is stored.</p>
                <p className="text-muted">The extension runs a short-lived local server to receive the sign-in callback.</p>
              </Step>
              <Step number={3} title="Select a space">
                <p>Your Confluence sites and spaces load after sign-in. Choose the spaces you want indexed.</p>
              </Step>
              <Step number={4} title="Sync">
                <p>Click <strong className="text-white">Sync</strong>. Pages are fetched, converted to Markdown, embedded, and stored on your machine, with live progress.</p>
              </Step>
              <Step number={5} title="Stays current in the background">
                <p>A background sync keeps the index up to date. It shows its progress under <code className="bg-white/10 px-1 rounded text-xs">Settings → Knowledge</code> like any other sync, and <strong className="text-white">Stop</strong> ends it. If you quit mid-sync, indexing resumes the next time WorkspaceGPT starts.</p>
              </Step>
            </div>

            <div id="confluence-write" className="-mt-20 pt-20" />
            <h3 className="text-lg font-semibold text-white mb-2 mt-4 flex items-center gap-3">
              Read, edit and create pages <Badge color="brand">New</Badge>
            </h3>
            <p className="text-muted text-sm leading-relaxed mb-6">
              New in WorkspaceGPT Desktop 0.0.6, and coming to the editor extension in its next release.
            </p>
            <div className="grid sm:grid-cols-3 gap-4 mb-6">
              <Card icon="file-text" title="Read a pasted link" accent="blue">
                <p>Paste a page URL into chat and the agent reads it as markdown, with headings, tables, panels and code blocks intact.</p>
              </Card>
              <Card icon="pen" title="Edit a section" accent="brand">
                <p>Ask it to update a page and it rewrites one section, adds a section after another, or appends. The rest of the page is left exactly as it was.</p>
              </Card>
              <Card icon="plus" title="Create a page" accent="green">
                <p>It suggests where the page belongs, based on similar pages you&apos;ve synced, and asks you to choose. New pages are drafts unless you ask to publish.</p>
              </Card>
            </div>
            <ul className="space-y-3 text-sm text-muted mb-6">
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="shield-check" size={16} /></span><span><strong className="text-white">You approve every write.</strong> The change arrives as a review card with a before-and-after diff and an <em>Open in Confluence</em> link. Nothing is sent until you approve, and rejecting it with feedback sends the agent back to revise.</span></li>
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="puzzle" size={16} /></span><span><strong className="text-white">Rich content survives.</strong> Macros, mentions, images, status lozenges and complex tables are carried through as placeholders and restored exactly as they were, even inside the section being edited.</span></li>
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="clock" size={16} /></span><span><strong className="text-white">Page history is the undo.</strong> An edit saves a new page version, so the previous one is always one click away in Confluence. If someone else edits the page first, the agent re-reads it and redoes its change.</span></li>
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="sliders" size={16} /></span><span><strong className="text-white">Never unattended.</strong> Runs in Agent mode don&apos;t write to Confluence; they put the proposed content in their report instead. Switch to Ask when you want the page updated.</span></li>
            </ul>
            <div className="p-5 bg-surface border border-yellow-500/20 rounded-xl text-sm text-muted mb-4">
              <span className="text-yellow-400 font-semibold">Connected before page editing arrived?</span> Your connection is
              read-only. Disconnect and connect again under <code className="bg-white/10 px-1 rounded text-xs">Settings → Knowledge → Confluence</code> to
              grant edit access. Disconnecting clears the synced pages, so run a sync again afterwards.
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <div className="p-5 bg-surface border border-line rounded-xl text-sm">
                <p className="text-white font-semibold mb-1">Token security</p>
                <p className="text-muted">Access and refresh tokens are stored in your editor&apos;s encrypted secret storage (the macOS Keychain or Windows Credential Manager on Desktop), never in plaintext settings.</p>
              </div>
              <div className="p-5 bg-surface border border-line rounded-xl text-sm">
                <p className="text-white font-semibold mb-1">Disconnect anytime</p>
                <p className="text-muted">Use <strong className="text-white">Disconnect</strong> under <code className="bg-white/10 px-1 rounded text-xs">Settings → Knowledge → Confluence</code> to revoke access and clear the synced data.</p>
              </div>
            </div>
          </section>

          {/* ── Jira ────────────────────────────────────────────── */}
          <SectionAnchor id="jira" />
          <section className="mb-16">
            <SectionTitle>Jira</SectionTitle>
            <SectionSubtitle>
              Connect Jira with the same one-click Atlassian sign-in, so the agent can read the issue it is working on and find related ones.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Open Jira settings">
                <p>In WorkspaceGPT, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Knowledge → Jira</code>.</p>
              </Step>
              <Step number={2} title="Connect with Atlassian">
                <p>Click <strong className="text-white">Connect</strong> and approve access on Atlassian&apos;s consent screen. No password or API token is stored.</p>
              </Step>
              <Step number={3} title="Pick a project and sync">
                <p>Choose your Jira site and project, pick how far back to sync (from the last month up to three years), and start the sync. Issues are embedded and indexed on your machine.</p>
              </Step>
              <Step number={4} title="Work from an issue">
                <p>Mention an issue key such as <code className="bg-white/10 px-1 rounded text-xs">ENG-5012</code> in chat and the agent reads that issue directly, alongside the related docs and code.</p>
              </Step>
            </div>
          </section>

          {/* ── ADO ─────────────────────────────────────────────── */}
          <SectionAnchor id="ado" />
          <section className="mb-16">
            <SectionTitle>Azure DevOps</SectionTitle>
            <SectionSubtitle>
              Connect Azure DevOps to chat with work items, user stories, and pull requests.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Generate a Personal Access Token (PAT)">
                <p>In Azure DevOps, go to <strong className="text-white">User Settings → Personal Access Tokens → New Token</strong>.</p>
                <p>Grant at minimum: <Badge color="blue">Work Items — Read</Badge> <Badge color="blue">Code — Read</Badge></p>
              </Step>
              <Step number={2} title="Open ADO settings">
                <p>In WorkspaceGPT, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Knowledge → Azure DevOps</code>.</p>
              </Step>
              <Step number={3} title="Enter your organization URL and PAT">
                <p>Provide your Azure DevOps organization URL (e.g. <code className="bg-white/10 px-1 rounded text-xs">https://dev.azure.com/your-org</code>) and the PAT you generated.</p>
                <p className="text-muted">The PAT is kept in your editor&apos;s secret storage (the macOS Keychain or Windows Credential Manager on Desktop), never in plain settings.</p>
              </Step>
              <Step number={4} title="Select project and sync">
                <p>Your ADO projects load automatically. Select a project and click <strong className="text-white">Sync</strong>. The items assigned to you then appear under <em>Your work</em> when you open WorkspaceGPT, ready to start a run from.</p>
                <p>Work items are embedded and indexed locally — no data is sent to third-party servers.</p>
              </Step>
            </div>

            <div className="mt-4 p-5 bg-surface border border-line rounded-xl text-sm text-muted">
              <span className="text-blue-400 font-semibold">Auth format:</span> The extension uses <code className="bg-white/10 px-1 rounded text-xs">Basic base64(:PAT)</code> (colon-prefixed PAT) as required by the Azure DevOps REST API.
            </div>
          </section>

          {/* ── Browser Control ─────────────────────────────────── */}
          <SectionAnchor id="browser" />
          <section className="mb-16">
            <div className="mb-4 flex gap-2"><Badge color="brand">New</Badge><Badge color="blue">Desktop &middot; macOS</Badge></div>
            <SectionTitle>Browser Control</SectionTitle>
            <SectionSubtitle>
              WorkspaceGPT Desktop can use your own Chrome to check its work: open your app, click through a flow, and
              read the console and network. It uses your real profile, so pages behind your company&apos;s single sign-on
              just work.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Install WorkspaceGPT Desktop and the Chrome extension">
                <p>
                  You need <Link href="/#install" className="text-brand hover:underline">WorkspaceGPT Desktop</Link> 0.0.6 or later on
                  macOS, and the{" "}
                  <a href="https://chromewebstore.google.com/detail/gagogpeepmgaljpabdlpbcknjnbcaole" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    WorkspaceGPT Chrome extension
                  </a>{" "}
                  (0.3.0 or later). Open Desktop once so it can register itself with your browsers. It works with Chrome, Chromium, Brave, Edge and Arc.
                </p>
              </Step>
              <Step number={2} title="Turn it on in the Chrome extension">
                <p>
                  Open the extension&apos;s side panel, go to <strong className="text-white">Settings</strong>, and check{" "}
                  <strong className="text-white">Let WorkspaceGPT use this browser</strong>. Chrome asks for permission
                  first. The panel shows <em>Connected to WorkspaceGPT Desktop</em> once the two are talking.
                </p>
              </Step>
              <Step number={3} title="Ask the agent to use it">
                <p>
                  The browser tools appear in the agent&apos;s toolbox only while the extension is connected. Ask it to
                  check a page, reproduce a bug in the UI, or confirm a fix, and it opens a tab in its own{" "}
                  <strong className="text-white">WorkspaceGPT</strong> tab group.
                </p>
              </Step>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">What it can do</h3>
            <div className="grid sm:grid-cols-2 gap-4 mb-8">
              <Card icon="pointer" title="Act" accent="brand">
                <p>List, open and close tabs; navigate; click, double-click and right-click; hover; type and press keys; fill forms; scroll; drag; answer page dialogs; and wait for a page to settle.</p>
              </Card>
              <Card icon="search" title="Observe" accent="blue">
                <p>Read a page&apos;s text or its interactive elements, take screenshots, run a JavaScript expression, and read the console and network requests.</p>
              </Card>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">Where it stops</h3>
            <ul className="space-y-3 text-sm text-muted mb-6">
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="folder" size={16} /></span><span>It acts only on tabs in its own <strong className="text-white">WorkspaceGPT</strong> tab group, or on the tab you&apos;re looking at. Your other tabs are left alone.</span></li>
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="lock" size={16} /></span><span>It refuses to type into password fields, including ones inside frames and shadow DOM. Sign in yourself; it then uses the session you created.</span></li>
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="message-square" size={16} /></span><span>It asks in chat before anything hard to undo, like submitting an order or sending a message.</span></li>
              <li className="flex gap-3"><span className="text-brand flex-shrink-0 mt-0.5"><Icon name="alert" size={16} /></span><span>While it acts, Chrome shows a <em>&ldquo;WorkspaceGPT&rdquo; started debugging this browser</em> bar. Click <strong className="text-white">Cancel</strong> there to stop it immediately.</span></li>
            </ul>
            <div className="p-5 bg-surface border border-line rounded-xl text-sm text-muted">
              <span className="text-white font-semibold">Turning it off:</span> uncheck the setting in the Chrome extension.
              That also removes the extra permissions Chrome granted when you turned it on. What the agent reads from a page becomes part of the
              conversation, like any other context, so it goes wherever your model runs. See the{" "}
              <Link href="/privacy#browser" className="text-brand hover:underline">privacy policy</Link>. Windows support and the
              editor extension are on the way.
            </div>
          </section>

          {/* ── Deployment Automation ───────────────────────────── */}
          <SectionAnchor id="deployment" />
          <section className="mb-16">
            <div className="mb-4"><Badge color="purple">Enterprise</Badge></div>
            <SectionTitle>Deployment Automation</SectionTitle>
            <SectionSubtitle>
              Turn the manual release checklist — syncing feature flags, env vars, and component
              versions across environments — into a reviewable, one-click pipeline. The model is
              inspired by AWS CodePipeline: a pluggable <strong className="text-white">Source</strong>{" "}
              feeds ordered <strong className="text-white">Stages</strong> of{" "}
              <strong className="text-white">Actions</strong>. Nothing is hardwired to one team&apos;s setup.
            </SectionSubtitle>

            <div className="grid sm:grid-cols-3 gap-4 mb-8">
              <Card icon="puzzle" title="Pluggable" accent="purple">
                <p>Pick a source, then add only the deploy actions your org actually uses. No provider is baked in.</p>
              </Card>
              <Card icon="shield-check" title="Plan → Approve → Apply" accent="green">
                <p>Every change is previewed as a diff you approve before anything is written. Backend changes open a PR — never an auto-merge.</p>
              </Card>
              <Card icon="search" title="Discover &amp; select" accent="blue">
                <p>Repos, workflows, projects, and table columns are detected from your connected accounts — choose from dropdowns, don&apos;t type IDs.</p>
              </Card>
            </div>

            <div className="bg-surface border border-brand/20 rounded-xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="text-white font-semibold mb-1">Full deployment guide</p>
                <p className="text-muted text-sm">Sources, actions, connections (PAT/SSO + Vercel gotchas), the Releases workflow, environments, security, troubleshooting &amp; FAQ.</p>
              </div>
              <Link href="/docs/deployment" className="flex-shrink-0 bg-brand hover:bg-[#3df5c2] text-black font-semibold px-5 py-2.5 rounded-full text-sm transition-colors text-center">
                Read the guide →
              </Link>
            </div>
          </section>

          {/* ── MCP ─────────────────────────────────────────────── */}
          <SectionAnchor id="mcp" />
          <section className="mb-16">
            <SectionTitle>MCP Server</SectionTitle>
            <SectionSubtitle>
              WorkspaceGPT ships an MCP (Model Context Protocol) server that gives other AI tools &mdash; GitHub Copilot, Cursor, Claude Desktop, Claude Code &mdash; search over your Confluence, Jira, Azure DevOps and workspace knowledge.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Connect the MCP Server">
                <p>Open the Command Palette (<kbd className="bg-white/10 text-foreground px-2 py-0.5 rounded text-xs font-mono">Cmd/Ctrl+Shift+P</kbd>) and run:</p>
                <CodeBlock language="vscode command">WorkspaceGPT: Connect MCP Server</CodeBlock>
              </Step>
              <Step number={2} title="Use with GitHub Copilot or Claude">
                <p>The MCP server is registered as a definition provider for Copilot Chat (<code className="bg-white/10 px-1 rounded text-xs">@mcp</code>). Once connected, Copilot and Claude can query your indexed data directly via the WorkspaceGPT context.</p>
              </Step>
            </div>

            <div className="mt-4 p-5 bg-surface border border-brand/20 rounded-xl text-sm text-muted">
              <span className="text-brand font-semibold">Status bar indicator:</span> After connecting, a WorkspaceGPT button appears in the VS Code status bar showing MCP connection health.
            </div>
          </section>

          {/* ── Commands ──────────────────────────────────────────── */}
          <SectionAnchor id="commands" />
          <section className="mb-16">
            <SectionTitle>Commands &amp; Keyboard Shortcuts</SectionTitle>
            <SectionSubtitle>All commands are accessible from the Command Palette.</SectionSubtitle>

            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface">
                    <th className="text-left px-5 py-3 text-muted font-semibold">Command</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Shortcut</th>
                    <th className="text-left px-5 py-3 text-muted font-semibold">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[
                    { cmd: "WorkspaceGPT: Ask", shortcut: "Cmd+Shift+R / Ctrl+Shift+R", desc: "Open & focus the WorkspaceGPT chat panel." },
                    { cmd: "WorkspaceGPT: New Chat", shortcut: "—", desc: "Start a fresh conversation, clearing history." },
                    { cmd: "WorkspaceGPT: Settings", shortcut: "—", desc: "Open the settings panel inside the sidebar." },
                    { cmd: "WorkspaceGPT: Chat History", shortcut: "—", desc: "Browse and restore previous chat sessions." },
                    { cmd: "WorkspaceGPT: Connect MCP Server", shortcut: "—", desc: "Register the MCP server for Copilot / Claude." },
                    { cmd: "WorkspaceGPT: Open Chat in Editor", shortcut: "—", desc: "Move the chat into a full editor tab; several sessions can run at once." },
                    { cmd: "WorkspaceGPT: Restore Chat to Sidebar", shortcut: "—", desc: "Move an editor-tab chat back into the sidebar." },
                    { cmd: "WorkspaceGPT: Revert Agent Changes…", shortcut: "—", desc: "Roll the workspace back to a checkpoint taken before an agent run wrote files." },
                    { cmd: "WorkspaceGPT: Sign In (Remote Mode)", shortcut: "—", desc: "Sign in with GitHub to use Remote mode's managed model." },
                    { cmd: "WorkspaceGPT: Sign Out (Remote Mode)", shortcut: "—", desc: "Sign out and delete your Remote-mode session token." },
                    { cmd: "WorkspaceGPT: Releases", shortcut: "—", desc: "Open deployment automation (config-sync and hotfix releases)." },
                    { cmd: "WorkspaceGPT: Clear All Data and Cache", shortcut: "—", desc: "Wipe all embeddings, state, and tokens." },
                  ].map((row) => (
                    <tr key={row.cmd} className="bg-background hover:bg-surface-2 transition-colors">
                      <td className="px-5 py-3 font-mono text-brand-blue text-xs">{row.cmd}</td>
                      <td className="px-5 py-3 text-muted font-mono text-xs whitespace-nowrap">{row.shortcut}</td>
                      <td className="px-5 py-3 text-muted">{row.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-lg font-semibold text-white mt-8 mb-4">Activity Bar &amp; Title Bar Icons</h3>
            <div className="grid sm:grid-cols-3 gap-4">
              <Card icon="plus" title="New Chat" accent="brand">
                <p>Click the <strong className="text-white">+</strong> icon in the WorkspaceGPT title bar to start a new session.</p>
              </Card>
              <Card icon="settings" title="Settings" accent="blue">
                <p>The gear icon opens Settings: mode, model, and your Knowledge sources.</p>
              </Card>
              <Card icon="clock" title="History" accent="purple">
                <p>Browse, restore, or delete previous chat sessions.</p>
              </Card>
            </div>
          </section>

          {/* ── Reset ────────────────────────────────────────────── */}
          <SectionAnchor id="reset" />
          <section className="mb-16">
            <SectionTitle>Reset &amp; Clear Data</SectionTitle>
            <SectionSubtitle>
              WorkspaceGPT stores all data locally in VS Code&apos;s global storage. You can wipe everything at any time.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Via Command Palette">
                <p>Run <code className="bg-white/10 px-1 rounded text-xs font-mono">WorkspaceGPT: Clear All Data and Cache</code> from the Command Palette. A confirmation prompt will appear.</p>
              </Step>
              <Step number={2} title="Via Settings panel">
                <p>Open <code className="bg-white/10 px-1 rounded text-xs">Settings → Reset VSCode State</code> inside the WorkspaceGPT sidebar.</p>
              </Step>
            </div>

            <div className="mt-2 p-5 bg-surface border border-red-500/20 rounded-xl text-sm text-muted">
              <span className="text-red-400 font-semibold">Warning:</span> This action clears all embeddings, OAuth tokens, PATs, and chat history. It cannot be undone. Background schedulers are stopped automatically before the wipe.
            </div>
          </section>

          {/* ── Troubleshooting ────────────────────────────────── */}
          <SectionAnchor id="troubleshooting" />
          <section className="mb-16">
            <SectionTitle>Troubleshooting</SectionTitle>
            <SectionSubtitle>Common issues and how to fix them.</SectionSubtitle>

            <div className="space-y-4">
              {[
                {
                  problem: "Extension not loading / sidebar not showing",
                  fix: "Ensure VS Code ≥ 1.98.0. Check the Extensions panel for error banners. Try reloading the window (Cmd/Ctrl+Shift+P → Reload Window).",
                },
                {
                  problem: "Ollama models not appearing",
                  fix: "Make sure the Ollama server is running (ollama serve). The default endpoint is http://localhost:11434. Verify at least one model is pulled: ollama list.",
                },
                {
                  problem: "Codebase tools are unavailable",
                  fix: "Open a folder or workspace in the current editor window, then start a new chat turn. WorkspaceGPT explores live files and does not build a codebase index.",
                },
                {
                  problem: "Confluence sync fails",
                  fix: "Re-authenticate: Settings → Knowledge → Confluence → Disconnect, then Connect again and re-run the sync. Ensure your Atlassian account has read access to the target space.",
                },
                {
                  problem: "“Confluence is connected read-only” when asking for an edit",
                  fix: "The connection was made before page editing existed. Disconnect and connect again under Settings → Knowledge → Confluence to grant edit access, then sync your space again.",
                },
                {
                  problem: "The agent says it can't edit Confluence in Agent mode",
                  fix: "That's by design: runs in Agent mode never write to shared docs. Switch the composer chip to Ask and ask again; you'll get a review card to approve.",
                },
                {
                  problem: "ADO sync not working",
                  fix: "Verify your PAT has Work Items — Read and Code — Read scopes. Re-enter the PAT in Settings → Knowledge → Azure DevOps. Check the organization URL format: https://dev.azure.com/your-org.",
                },
                {
                  problem: "Chat returns no results or irrelevant answers",
                  fix: "Confirm the relevant data source is indexed (check the sync status in Settings). Try re-syncing. For better quality answers, switch to a larger Ollama model or a cloud provider.",
                },
                {
                  problem: "MCP server not detected by Copilot",
                  fix: "Run WorkspaceGPT: Connect MCP Server from the Command Palette. Reload the window after connecting.",
                },
                {
                  problem: "Browser tools don't appear, or the extension says “Not connected”",
                  fix: "Browser control needs WorkspaceGPT Desktop 0.0.6 or later on macOS. Open Desktop once after installing it so it can register with your browsers, then turn on “Let WorkspaceGPT use this browser” in the Chrome extension's Settings. Make sure Desktop is running.",
                },
                {
                  problem: "A sync shows no progress after a restart",
                  fix: "Update to extension 2.0.44 or Desktop 0.0.4 or later. Syncs started in the background or resumed after a restart now show their progress under Settings → Knowledge and can be stopped from there.",
                },
              ].map((item) => (
                <details key={item.problem} className="group bg-surface border border-line rounded-xl overflow-hidden">
                  <summary className="flex items-center justify-between px-5 py-4 cursor-pointer text-white font-medium hover:bg-white/5 transition-colors list-none">
                    <span className="flex items-center gap-3">
                      <span className="text-yellow-400"><Icon name="alert" size={16} /></span>
                      {item.problem}
                    </span>
                    <svg className="w-4 h-4 text-muted group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <div className="px-5 pb-5 pt-1 text-sm text-muted border-t border-line">
                    {item.fix}
                  </div>
                </details>
              ))}
            </div>

            <div className="mt-8 p-6 bg-surface border border-line rounded-xl">
              <h4 className="text-white font-semibold mb-2">Still need help?</h4>
              <div className="flex flex-wrap gap-4 text-sm">
                <a href="https://github.com/ritesh-kant/workspaceGPT/issues" target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline">Open a GitHub issue →</a>
                <a href="mailto:contact@workspacegpt.in" className="text-brand-blue hover:underline">Email support →</a>
                <a href="https://devnotes.tech/tag/workspacegpt/" target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline">Read the blog →</a>
              </div>
            </div>
          </section>

        </main>
      </div>

      {/* Footer */}
      <SiteFooter />
    </div>
  );
}
