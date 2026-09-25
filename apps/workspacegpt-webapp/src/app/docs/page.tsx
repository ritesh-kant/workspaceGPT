"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "installation", label: "Installation" },
  { id: "modes", label: "Modes & Privacy" },
  { id: "ai-providers", label: "AI Providers" },
  { id: "codebase", label: "Codebase Exploration" },
  { id: "embeddings", label: "Embeddings & Vector Storage" },
  { id: "confluence", label: "Confluence" },
  { id: "jira", label: "Jira" },
  { id: "ado", label: "Azure DevOps" },
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
    <div className="relative group rounded-xl bg-slate-950 border border-white/10 overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/2">
        <span className="text-xs text-slate-500 font-mono">{language}</span>
        <button onClick={copy} className="text-xs text-slate-500 hover:text-white transition-colors">
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
        <div className="text-slate-300 text-sm leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

function Card({ title, icon, children, accent = "brand" }: { title: string; icon: string; children: React.ReactNode; accent?: string }) {
  const accents: Record<string, string> = {
    brand: "hover:border-brand/40",
    blue: "hover:border-blue-500/40",
    purple: "hover:border-purple-500/40",
    green: "hover:border-emerald-500/40",
  };
  return (
    <div className={`bg-slate-900 border border-white/5 rounded-2xl p-6 ${accents[accent] ?? accents.brand} transition-colors duration-300`}>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xl">{icon}</span>
        <h4 className="text-white font-semibold">{title}</h4>
      </div>
      <div className="text-slate-300 text-sm leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl sm:text-3xl font-bold text-white mb-2 tracking-tight">{children}</h2>
  );
}

function SectionSubtitle({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-400 mb-8 text-base">{children}</p>;
}

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("overview");

  return (
    <div className="flex flex-col min-h-screen bg-[#030712] text-slate-200">
      {/* Background glows */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-brand/5 blur-[150px] rounded-full pointer-events-none -z-10" />
      <div className="fixed bottom-0 right-0 w-[400px] h-[400px] bg-brand-blue/10 blur-[120px] rounded-full pointer-events-none -z-10" />

      {/* Top nav */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#030712]/80 backdrop-blur-md">
        <div className="container mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <Image src="/icon.png" width={24} height={24} alt="WorkspaceGPT" className="opacity-90" />
            <span className="font-bold text-white text-sm">WorkspaceGPT</span>
            <span className="text-slate-500 text-sm hidden sm:inline">/ Docs</span>
          </Link>
          <nav className="hidden md:flex items-center gap-5 text-sm text-slate-400">
            <a href="https://github.com/ritesh-kant/workspaceGPT" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
            <a href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="bg-brand hover:bg-[#1ce2a7] text-black font-semibold px-4 py-1.5 rounded-full text-sm transition-colors">
              Install Extension
            </a>
          </nav>
        </div>
      </header>

      <div className="container mx-auto px-4 sm:px-6 flex gap-0 lg:gap-10 flex-1">
        {/* Sidebar */}
        <aside className="hidden lg:block w-56 xl:w-64 flex-shrink-0 py-10">
          <div className="sticky top-24 space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 px-3">On this page</p>
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setActiveSection(s.id)}
                className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeSection === s.id
                    ? "bg-brand/10 text-brand font-medium"
                    : "text-slate-400 hover:text-white hover:bg-white/5"
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
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand text-xs font-medium mb-6">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-brand" />
              </span>
              New: WorkspaceGPT Desktop for macOS
            </div>
            <SectionTitle>WorkspaceGPT Docs</SectionTitle>
            <SectionSubtitle>
              Everything you need to install, configure, and get the most out of WorkspaceGPT &mdash; in VS Code, Cursor or Antigravity, or as the WorkspaceGPT Desktop app on a Mac.
            </SectionSubtitle>

            <div className="grid sm:grid-cols-3 gap-4">
              <Card icon="🔐" title="Privacy-First" accent="green">
                <p>Indexing and embeddings run on-device and the vector index stays in local files — in <em>both</em> modes. We retain nothing.</p>
              </Card>
              <Card icon="🤖" title="Agentic" accent="brand">
                <p>Reads and edits your code, then runs your checks to verify it. Retrieval over your Confluence docs and Jira and Azure DevOps tickets supplies the &ldquo;why&rdquo;.</p>
              </Card>
              <Card icon="⚡" title="Zero Setup" accent="blue">
                <p>Install from the marketplace and start chatting in under 2 minutes.</p>
              </Card>
            </div>
          </section>

          {/* ── Installation ─────────────────────────────────── */}
          <SectionAnchor id="installation" />
          <section className="mb-16">
            <SectionTitle>Installation</SectionTitle>
            <SectionSubtitle>Available in the VS Code and Cursor marketplaces, on Open VSX for Antigravity, and as a Mac app.</SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Via Extensions Marketplace">
                <p>Open VS Code, Cursor, or Antigravity and navigate to the Extensions view:</p>
                <p>
                  <kbd className="bg-white/10 text-slate-200 px-2 py-0.5 rounded text-xs font-mono">Ctrl+Shift+X</kbd>
                  {" "}&nbsp;or{" "}&nbsp;
                  <kbd className="bg-white/10 text-slate-200 px-2 py-0.5 rounded text-xs font-mono">Cmd+Shift+X</kbd>
                  {" "}on macOS
                </p>
                <p>Search for <strong className="text-white">WorkspaceGPT</strong> and click <strong className="text-white">Install</strong>.</p>
              </Step>

              <Step number={2} title="Via Command Palette">
                <p>Press <kbd className="bg-white/10 text-slate-200 px-2 py-0.5 rounded text-xs font-mono">Ctrl+P</kbd> to open Quick Open and run:</p>
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

              <Step number={5} title="WorkspaceGPT Desktop (macOS, no editor needed)">
                <p>The same agent as a standalone Mac app, for Apple Silicon and Intel on macOS 12 or later. Paste this into Terminal:</p>
                <CodeBlock language="bash">curl -fsSL https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.sh | sh</CodeBlock>
                <p>
                  The installer downloads the build for your Mac, checks its SHA-256 against the release, and installs it into{" "}
                  <code className="bg-white/10 px-1 rounded text-xs">/Applications</code>. Prefer a DMG? Download it from the{" "}
                  <a href="https://github.com/ritesh-kant/workspaceGPT/releases?q=desktop-v&amp;expanded=true" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    GitHub releases
                  </a>
                  . The app isn&apos;t notarized yet, so a DMG copy needs one <strong className="text-white">Open Anyway</strong> in System Settings → Privacy &amp; Security the first time; the Terminal installer doesn&apos;t.
                </p>
                <p className="text-slate-400">
                  Desktop updates itself: it checks for a new version in the background, verifies its signature, and installs it the next time you quit or when you choose <strong className="text-white">Restart Now</strong>. Secrets live in your macOS Keychain. Windows and Linux builds are not available yet.
                </p>
              </Step>
            </div>

            <div className="bg-slate-900 border border-white/5 rounded-2xl p-5 mt-2">
              <p className="text-sm text-slate-300">
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

            <div className="p-5 bg-slate-900 border border-emerald-500/20 rounded-2xl text-sm text-slate-300 mb-8">
              <span className="text-emerald-400 font-semibold">Your index never moves.</span> Embeddings are
              generated on-device and the vector index is written to local files inside the extension&apos;s
              storage, in <strong className="text-white">both</strong> modes. Switching modes never uploads
              anything and never requires a re-index.
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mb-8">
              <Card icon="🔐" title="Local" accent="green">
                <p>Everything runs on your machine: the chat model, the embeddings, the index, the retrieval.</p>
                <p>Use Ollama for a fully offline setup, or supply your own key for OpenAI, Claude, Gemini, Groq, OpenRouter, NVIDIA, or any OpenAI-compatible endpoint. No WorkspaceGPT account needed.</p>
              </Card>
              <Card icon="⚡" title="Remote" accent="brand">
                <div className="mb-2"><Badge color="brand">Preview</Badge></div>
                <p>We run the inference infrastructure and pick the model, so there is no provider key to buy and nothing to configure.</p>
                <p>Sign in with GitHub once. Your question and the snippets retrieved for it are sent to our endpoint per request; your documents, code and index stay on your machine.</p>
              </Card>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">What each mode sends</h3>
            <div className="overflow-x-auto rounded-2xl border border-white/10 mb-8">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900">
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">&nbsp;</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Local</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Remote</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {[
                    ["Documents, code, work items", "Never leave your machine", "Never leave your machine"],
                    ["Embeddings", "Generated on-device", "Generated on-device"],
                    ["Vector index", "Local files", "Local files"],
                    ["Question + retrieved snippets", "To your chosen provider, or nowhere with Ollama", "To our endpoint, then the upstream model"],
                    ["Account", "None", "GitHub sign-in, verified per request"],
                    ["Model keys you supply", "Yours, or none with Ollama", "None"],
                    ["Stored by WorkspaceGPT", "Nothing", "Nothing but your account row"],
                  ].map(([label, local, remote]) => (
                    <tr key={label} className="bg-slate-950 align-top">
                      <td className="px-5 py-3 font-medium text-white">{label}</td>
                      <td className="px-5 py-3 text-slate-400">{local}</td>
                      <td className="px-5 py-3 text-slate-400">{remote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">Zero data retention</h3>
            <p className="text-slate-300 text-sm leading-relaxed mb-4">
              In Remote mode your request is held in memory only for as long as it takes to stream the answer
              back, then discarded. We do not write prompts, answers, or retrieved snippets to any database, any
              file, or any log &mdash; our servers log status codes and error types only. The entirety of what we
              store per account is: your GitHub id and handle, your plan and status, an opaque session token that
              expires in 30 days, and how many credits you have used this week.
            </p>
            <p className="text-slate-300 text-sm leading-relaxed mb-8">
              Generation itself is performed by an upstream model provider (currently OpenRouter) under its own
              policy. If you need a guarantee that covers the whole path contractually, use Local mode with
              Ollama &mdash; no third party is involved at all. Full detail in the{" "}
              <Link href="/privacy" className="text-brand hover:underline">privacy policy</Link>.
            </p>

            <div className="p-5 bg-slate-900 border border-yellow-500/20 rounded-2xl text-sm text-slate-300">
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

            <div className="overflow-x-auto rounded-2xl border border-white/10 mb-8">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900">
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Provider</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Privacy</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Requires API Key</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
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
                    <tr key={row.name} className="bg-slate-950 hover:bg-slate-900/60 transition-colors">
                      <td className="px-5 py-3 font-medium text-white">{row.name}</td>
                      <td className="px-5 py-3"><Badge color={row.badge}>{row.privacy}</Badge></td>
                      <td className="px-5 py-3 text-slate-400">{row.key}</td>
                      <td className="px-5 py-3 text-slate-400">{row.note}</td>
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
                <p className="text-slate-400">For better responses, try a larger model:</p>
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
            <p className="text-slate-400 text-sm mb-4">Open <code className="bg-white/10 px-1 rounded text-xs">Settings → Providers</code>, select your provider, and paste your API key. Keys are stored securely in VS Code&apos;s secret storage and never logged.</p>
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

            <div className="mt-4 p-5 bg-slate-900 border border-yellow-500/20 rounded-2xl text-sm text-slate-300">
              <span className="text-yellow-400 font-semibold">Note:</span> Codebase exploration does not create embeddings or a persistent index of your workspace. Availability depends on having a folder open in the current editor window.
            </div>
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

            <div className="p-5 bg-slate-900 border border-emerald-500/20 rounded-2xl text-sm text-slate-300 mb-8">
              <span className="text-emerald-400 font-semibold">On-device, always.</span> Indexing is not affected by
              the Local/Remote mode switch. There is no cloud embedding provider and no hosted vector store to
              configure &mdash; and therefore no way for your content to reach us.
            </div>

            <h3 className="text-lg font-semibold text-white mb-4">Embedding model</h3>
            <div className="overflow-x-auto rounded-2xl border border-white/10 mb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900">
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Provider</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Model</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">API key</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Best for</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr className="bg-slate-950 align-top">
                    <td className="px-5 py-3 font-medium text-white">Text <Badge color="green">Bundled</Badge></td>
                    <td className="px-5 py-3 text-slate-400">Xenova/all-MiniLM-L6-v2 (384-dim)</td>
                    <td className="px-5 py-3 text-slate-400">Not needed</td>
                    <td className="px-5 py-3 text-slate-400">Confluence pages, Jira issues and ADO work items. Runs on-device; first run downloads ~200&nbsp;MB.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-400 text-sm mb-8">
              Nothing to configure &mdash; the models ship with the extension and are used automatically.
            </p>

            <h3 className="text-lg font-semibold text-white mb-4">Vector storage</h3>
            <div className="mb-4">
              <Card icon="💾" title="Local files, on this machine" accent="green">
                <p>Vectors are written to binary files in the extension&apos;s own storage directory. They are never uploaded, mirrored, or backed up by us.</p>
                <p>Clear them any time with <code className="bg-white/10 px-1 rounded text-xs">Settings → Reset</code> or the <strong className="text-white">Clear Data</strong> command.</p>
              </Card>
            </div>

            <div className="p-5 bg-slate-900 border border-yellow-500/20 rounded-2xl text-sm text-slate-300">
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
              Connect your Atlassian Confluence space with one-click OAuth 2.0 authentication.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Open Confluence settings">
                <p>In WorkspaceGPT, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Confluence</code>.</p>
              </Step>
              <Step number={2} title="Sign in with Atlassian">
                <p>Click <strong className="text-white">Connect to Confluence</strong>. A browser window will open to Atlassian&apos;s OAuth consent screen. Sign in and grant access — no passwords are stored.</p>
                <p className="text-slate-400">The extension spins up a short-lived local HTTP server to capture the OAuth callback securely.</p>
              </Step>
              <Step number={3} title="Select a space">
                <p>After authentication, your accessible Confluence sites and spaces will load. Select the spaces you want to index.</p>
              </Step>
              <Step number={4} title="Start Sync">
                <p>Click <strong className="text-white">Start Sync</strong>. Pages are fetched, converted to Markdown, embedded, and stored locally. Progress is shown in real-time.</p>
              </Step>
              <Step number={5} title="Automatic background sync">
                <p>The <code className="bg-white/10 px-1 rounded text-xs">ConfluenceSyncScheduler</code> starts automatically on extension activation and keeps your index up-to-date in the background.</p>
              </Step>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <div className="p-5 bg-slate-900 border border-white/5 rounded-2xl text-sm">
                <p className="text-slate-300 font-semibold mb-1">Token security</p>
                <p className="text-slate-400">OAuth access + refresh tokens are stored in your editor&apos;s encrypted secret storage (the macOS Keychain on Desktop) — never in plaintext settings.</p>
              </div>
              <div className="p-5 bg-slate-900 border border-white/5 rounded-2xl text-sm">
                <p className="text-slate-300 font-semibold mb-1">Disconnect anytime</p>
                <p className="text-slate-400">Go to <code className="bg-white/10 px-1 rounded text-xs">Settings → Confluence → Disconnect</code> to revoke access and clear all synced data.</p>
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
                <p>In WorkspaceGPT, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Jira</code>.</p>
              </Step>
              <Step number={2} title="Connect with Atlassian">
                <p>Click <strong className="text-white">Connect to Jira</strong> and approve access on Atlassian&apos;s consent screen. No password or API token is stored.</p>
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
                <p>In WorkspaceGPT, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Azure DevOps</code>.</p>
              </Step>
              <Step number={3} title="Enter your organization URL and PAT">
                <p>Provide your Azure DevOps organization URL (e.g. <code className="bg-white/10 px-1 rounded text-xs">https://dev.azure.com/your-org</code>) and the PAT you generated.</p>
                <p className="text-slate-400">The PAT is kept in your editor&apos;s secret storage (the macOS Keychain on Desktop), never in plain settings.</p>
              </Step>
              <Step number={4} title="Select project and sync">
                <p>Your ADO projects will load automatically. Select a project and click <strong className="text-white">Start Sync</strong>.</p>
                <p>Work items are embedded and indexed locally — no data is sent to third-party servers.</p>
              </Step>
            </div>

            <div className="mt-4 p-5 bg-slate-900 border border-white/5 rounded-2xl text-sm text-slate-300">
              <span className="text-blue-400 font-semibold">Auth format:</span> The extension uses <code className="bg-white/10 px-1 rounded text-xs">Basic base64(:PAT)</code> (colon-prefixed PAT) as required by the Azure DevOps REST API.
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
              <Card icon="🧩" title="Pluggable" accent="purple">
                <p>Pick a source, then add only the deploy actions your org actually uses. No provider is baked in.</p>
              </Card>
              <Card icon="🛡️" title="Plan → Approve → Apply" accent="green">
                <p>Every change is previewed as a diff you approve before anything is written. Backend changes open a PR — never an auto-merge.</p>
              </Card>
              <Card icon="🔍" title="Discover &amp; select" accent="blue">
                <p>Repos, workflows, projects, and table columns are detected from your connected accounts — choose from dropdowns, don&apos;t type IDs.</p>
              </Card>
            </div>

            <div className="bg-slate-900 border border-brand/20 rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <p className="text-white font-semibold mb-1">Full deployment guide</p>
                <p className="text-slate-400 text-sm">Sources, actions, connections (PAT/SSO + Vercel gotchas), the Releases workflow, environments, security, troubleshooting &amp; FAQ.</p>
              </div>
              <Link href="/docs/deployment" className="flex-shrink-0 bg-brand hover:bg-[#1ce2a7] text-black font-semibold px-5 py-2.5 rounded-full text-sm transition-colors text-center">
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
                <p>Open the Command Palette (<kbd className="bg-white/10 text-slate-200 px-2 py-0.5 rounded text-xs font-mono">Cmd/Ctrl+Shift+P</kbd>) and run:</p>
                <CodeBlock language="vscode command">WorkspaceGPT: Connect MCP Server</CodeBlock>
              </Step>
              <Step number={2} title="Use with GitHub Copilot or Claude">
                <p>The MCP server is registered as a definition provider for Copilot Chat (<code className="bg-white/10 px-1 rounded text-xs">@mcp</code>). Once connected, Copilot and Claude can query your indexed data directly via the WorkspaceGPT context.</p>
              </Step>
            </div>

            <div className="mt-4 p-5 bg-slate-900 border border-brand/20 rounded-2xl text-sm text-slate-300">
              <span className="text-brand font-semibold">Status bar indicator:</span> After connecting, a WorkspaceGPT button appears in the VS Code status bar showing MCP connection health.
            </div>
          </section>

          {/* ── Commands ──────────────────────────────────────────── */}
          <SectionAnchor id="commands" />
          <section className="mb-16">
            <SectionTitle>Commands &amp; Keyboard Shortcuts</SectionTitle>
            <SectionSubtitle>All commands are accessible from the Command Palette.</SectionSubtitle>

            <div className="overflow-x-auto rounded-2xl border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900">
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Command</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Shortcut</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {[
                    { cmd: "WorkspaceGPT: Ask", shortcut: "Cmd+Shift+R / Ctrl+Shift+R", desc: "Open & focus the WorkspaceGPT chat panel." },
                    { cmd: "WorkspaceGPT: New Chat", shortcut: "—", desc: "Start a fresh conversation, clearing history." },
                    { cmd: "WorkspaceGPT: Settings", shortcut: "—", desc: "Open the settings panel inside the sidebar." },
                    { cmd: "WorkspaceGPT: Chat History", shortcut: "—", desc: "Browse and restore previous chat sessions." },
                    { cmd: "WorkspaceGPT: Connect MCP Server", shortcut: "—", desc: "Register the MCP server for Copilot / Claude." },
                    { cmd: "WorkspaceGPT: Open Chat in Editor", shortcut: "—", desc: "Move the chat into a full editor tab; several sessions can run at once." },
                    { cmd: "WorkspaceGPT: Revert Agent Changes…", shortcut: "—", desc: "Roll the workspace back to a checkpoint taken before an agent run wrote files." },
                    { cmd: "WorkspaceGPT: Sign In (Remote Mode)", shortcut: "—", desc: "Sign in with GitHub to use Remote mode's managed model." },
                    { cmd: "WorkspaceGPT: Releases", shortcut: "—", desc: "Open deployment automation (config-sync and hotfix releases)." },
                    { cmd: "WorkspaceGPT: Clear All Data and Cache", shortcut: "—", desc: "Wipe all embeddings, state, and tokens." },
                  ].map((row) => (
                    <tr key={row.cmd} className="bg-slate-950 hover:bg-slate-900/60 transition-colors">
                      <td className="px-5 py-3 font-mono text-brand-blue text-xs">{row.cmd}</td>
                      <td className="px-5 py-3 text-slate-400 font-mono text-xs whitespace-nowrap">{row.shortcut}</td>
                      <td className="px-5 py-3 text-slate-300">{row.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-lg font-semibold text-white mt-8 mb-4">Activity Bar &amp; Title Bar Icons</h3>
            <div className="grid sm:grid-cols-3 gap-4">
              <Card icon="➕" title="New Chat" accent="brand">
                <p>Click the <strong className="text-white">+</strong> icon in the WorkspaceGPT title bar to start a new session.</p>
              </Card>
              <Card icon="⚙️" title="Settings" accent="blue">
                <p>The gear icon opens provider and integration configuration.</p>
              </Card>
              <Card icon="🕐" title="History" accent="purple">
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

            <div className="mt-2 p-5 bg-slate-900 border border-red-500/20 rounded-2xl text-sm text-slate-300">
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
                  fix: "Re-authenticate: Settings → Confluence → Disconnect, then Sign In again. Ensure your Atlassian account has read access to the target space.",
                },
                {
                  problem: "ADO sync not working",
                  fix: "Verify your PAT has Work Items — Read and Code — Read scopes. Re-enter the PAT in Settings → Azure DevOps. Check the organization URL format: https://dev.azure.com/your-org.",
                },
                {
                  problem: "Chat returns no results or irrelevant answers",
                  fix: "Confirm the relevant data source is indexed (check the sync status in Settings). Try re-syncing. For better quality answers, switch to a larger Ollama model or a cloud provider.",
                },
                {
                  problem: "MCP server not detected by Copilot",
                  fix: "Run WorkspaceGPT: Connect MCP Server from the Command Palette. Reload the window after connecting.",
                },
              ].map((item) => (
                <details key={item.problem} className="group bg-slate-900 border border-white/5 rounded-2xl overflow-hidden">
                  <summary className="flex items-center justify-between px-5 py-4 cursor-pointer text-white font-medium hover:bg-white/5 transition-colors list-none">
                    <span className="flex items-center gap-3">
                      <span className="text-yellow-400 text-sm">⚠</span>
                      {item.problem}
                    </span>
                    <svg className="w-4 h-4 text-slate-400 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <div className="px-5 pb-5 pt-1 text-sm text-slate-300 border-t border-white/5">
                    {item.fix}
                  </div>
                </details>
              ))}
            </div>

            <div className="mt-8 p-6 bg-slate-900 border border-white/5 rounded-2xl">
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
      <footer className="border-t border-white/5 py-8 bg-slate-950">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-slate-500">
          <p>© {new Date().getFullYear()} WorkspaceGPT. Proprietary Software.</p>
          <div className="flex gap-6">
            <Link href="/" className="hover:text-white transition-colors">Home</Link>
            <a href="https://github.com/ritesh-kant/workspaceGPT" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
            <a href="mailto:contact@workspacegpt.in" className="hover:text-white transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
