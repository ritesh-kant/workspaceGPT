"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "installation", label: "Installation" },
  { id: "ai-providers", label: "AI Providers" },
  { id: "codebase", label: "Codebase Indexing" },
  { id: "embeddings", label: "Embeddings & Vector Storage" },
  { id: "confluence", label: "Confluence Integration" },
  { id: "ado", label: "Azure DevOps" },
  { id: "deployment", label: "Deployment Automation" },
  { id: "mcp", label: "MCP Server" },
  { id: "chrome", label: "Chrome Extension" },
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
              v1.0.5 — Latest Release
            </div>
            <SectionTitle>WorkspaceGPT Extension Docs</SectionTitle>
            <SectionSubtitle>
              Everything you need to install, configure, and get the most out of WorkspaceGPT inside VS Code, Cursor, or Antigravity.
            </SectionSubtitle>

            <div className="grid sm:grid-cols-3 gap-4">
              <Card icon="🔐" title="Privacy-First" accent="green">
                <p>100% local with Ollama — no data leaves your machine. Cloud providers available optionally.</p>
              </Card>
              <Card icon="🤖" title="RAG-Powered" accent="brand">
                <p>Retrieval-Augmented Generation over your codebase, Confluence docs, and ADO tickets.</p>
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
            <SectionSubtitle>Available in the VS Code and Cursor marketplaces, and on Open VSX for Antigravity.</SectionSubtitle>

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
            </div>

            <div className="bg-slate-900 border border-white/5 rounded-2xl p-5 mt-2">
              <p className="text-sm text-slate-300">
                <span className="text-brand font-semibold">Minimum VS Code version:</span> 1.98.0. WorkspaceGPT activates automatically on startup (<code className="bg-white/10 px-1 rounded text-xs">onStartupFinished</code>).
              </p>
            </div>
          </section>

          {/* ── AI Providers ─────────────────────────────────── */}
          <SectionAnchor id="ai-providers" />
          <section className="mb-16">
            <SectionTitle>AI Providers</SectionTitle>
            <SectionSubtitle>
              Choose between fully local operation with Ollama or cloud-based providers for maximum capability.
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
                    { name: "Requestly", privacy: "Cloud", key: "Yes", note: "Custom API endpoint proxy integration.", badge: "yellow" },
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
            <SectionTitle>Codebase Indexing</SectionTitle>
            <SectionSubtitle>
              WorkspaceGPT indexes your local workspace files so you can chat with your own code.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Open the Codebase panel">
                <p>In the WorkspaceGPT sidebar, go to <code className="bg-white/10 px-1 rounded text-xs">Settings → Codebase</code>.</p>
              </Step>
              <Step number={2} title="Start Sync">
                <p>Click <strong className="text-white">Start Sync</strong>. The extension will walk the workspace folder tree, generate embeddings using the bundled local model (<code className="bg-white/10 px-1 rounded text-xs">all-MiniLM-L6-v2</code>), and store them in VS Code&apos;s global storage.</p>
              </Step>
              <Step number={3} title="Chat with your code">
                <p>Once indexing is complete, your questions will automatically draw context from your codebase alongside any other connected data sources.</p>
              </Step>
            </div>

            <div className="mt-4 p-5 bg-slate-900 border border-yellow-500/20 rounded-2xl text-sm text-slate-300">
              <span className="text-yellow-400 font-semibold">Note:</span> Large monorepos may take a few minutes to index on first run. Subsequent syncs are incremental and much faster.
            </div>
          </section>

          {/* ── Embeddings & Vector Storage ──────────────────────── */}
          <SectionAnchor id="embeddings" />
          <section className="mb-16">
            <SectionTitle>Embeddings &amp; Vector Storage</SectionTitle>
            <SectionSubtitle>
              Every connected source (codebase, Confluence, ADO) is turned into vector embeddings and stored so
              WorkspaceGPT can retrieve the right context. You control both halves: which model makes the embeddings,
              and where the vectors live.
            </SectionSubtitle>

            <h3 className="text-lg font-semibold text-white mb-4">Embedding provider</h3>
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
                    <td className="px-5 py-3 font-medium text-white">Local <Badge color="green">Default</Badge></td>
                    <td className="px-5 py-3 text-slate-400">Xenova/all-MiniLM-L6-v2 (384-dim)</td>
                    <td className="px-5 py-3 text-slate-400">Not needed</td>
                    <td className="px-5 py-3 text-slate-400">Full privacy — runs on-device, nothing leaves your machine. First run downloads ~200&nbsp;MB.</td>
                  </tr>
                  <tr className="bg-slate-950 align-top">
                    <td className="px-5 py-3 font-medium text-white">Google Gemini</td>
                    <td className="px-5 py-3 text-slate-400">gemini-embedding-001 (768-dim)</td>
                    <td className="px-5 py-3 text-slate-400">Required</td>
                    <td className="px-5 py-3 text-slate-400">Faster, higher quality, and required for sharing to the Chrome extension.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-slate-400 text-sm mb-8">
              Configure under <code className="bg-white/10 px-1 rounded text-xs">Settings → Embeddings</code>. Keys are stored in VS Code&apos;s encrypted secret storage.
            </p>

            <h3 className="text-lg font-semibold text-white mb-4">Vector storage</h3>
            <div className="grid sm:grid-cols-2 gap-4 mb-4">
              <Card icon="💾" title="Local (on this machine)" accent="green">
                <p>Vectors are written to binary files in the extension&apos;s storage. Nothing leaves your machine. The default — ideal for solo, privacy-critical use.</p>
              </Card>
              <Card icon="☁️" title="Cloud — Qdrant" accent="blue">
                <p>Vectors live in a Qdrant cluster (self-hosted or Qdrant Cloud). Provide the cluster <strong className="text-white">URL</strong> and <strong className="text-white">API key</strong>, then click <strong className="text-white">Test connection</strong>. Enables sharing and larger datasets.</p>
              </Card>
            </div>
            <p className="text-slate-400 text-sm mb-4">
              Configure under <code className="bg-white/10 px-1 rounded text-xs">Settings → Vector Storage</code>. Cloud-Qdrant URLs from the dashboard are auto-normalized to include the <code className="bg-white/10 px-1 rounded text-xs">:6333</code> port.
            </p>

            <div className="p-5 bg-slate-900 border border-yellow-500/20 rounded-2xl text-sm text-slate-300">
              <span className="text-yellow-400 font-semibold">Re-index when you switch:</span> changing the embedding
              provider or the storage location means existing vectors no longer match — WorkspaceGPT will prompt you to
              re-index your connected sources. (Different models also produce different vector dimensions.)
            </div>
          </section>

          {/* ── Confluence ─────────────────────────────────────── */}
          <SectionAnchor id="confluence" />
          <section className="mb-16">
            <SectionTitle>Confluence Integration</SectionTitle>
            <SectionSubtitle>
              Connect your Atlassian Confluence space with one-click OAuth 2.0 authentication.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Open Confluence settings">
                <p>In the WorkspaceGPT sidebar, navigate to <code className="bg-white/10 px-1 rounded text-xs">Settings → Confluence Integration</code>.</p>
              </Step>
              <Step number={2} title="Sign in with Atlassian">
                <p>Click <strong className="text-white">Sign In</strong>. A browser window will open to Atlassian&apos;s OAuth consent screen. Sign in and grant access — no passwords are stored.</p>
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
                <p className="text-slate-400">OAuth access + refresh tokens are stored in VS Code&apos;s encrypted <code className="bg-white/10 px-1 rounded text-xs">context.secrets</code> — never in plaintext settings.</p>
              </div>
              <div className="p-5 bg-slate-900 border border-white/5 rounded-2xl text-sm">
                <p className="text-slate-300 font-semibold mb-1">Disconnect anytime</p>
                <p className="text-slate-400">Go to <code className="bg-white/10 px-1 rounded text-xs">Settings → Confluence → Disconnect</code> to revoke access and clear all synced data.</p>
              </div>
            </div>
          </section>

          {/* ── ADO ─────────────────────────────────────────────── */}
          <SectionAnchor id="ado" />
          <section className="mb-16">
            <SectionTitle>Azure DevOps Integration</SectionTitle>
            <SectionSubtitle>
              Connect Azure DevOps to chat with work items, user stories, and pull requests.
            </SectionSubtitle>

            <div className="space-y-0">
              <Step number={1} title="Generate a Personal Access Token (PAT)">
                <p>In Azure DevOps, go to <strong className="text-white">User Settings → Personal Access Tokens → New Token</strong>.</p>
                <p>Grant at minimum: <Badge color="blue">Work Items — Read</Badge> <Badge color="blue">Code — Read</Badge></p>
              </Step>
              <Step number={2} title="Open ADO settings">
                <p>In the WorkspaceGPT sidebar, go to <code className="bg-white/10 px-1 rounded text-xs">Settings → Azure DevOps Integration</code>.</p>
              </Step>
              <Step number={3} title="Enter your organization URL and PAT">
                <p>Provide your Azure DevOps organization URL (e.g. <code className="bg-white/10 px-1 rounded text-xs">https://dev.azure.com/your-org</code>) and the PAT you generated.</p>
                <p className="text-slate-400">The PAT is stored in VS Code&apos;s <code className="bg-white/10 px-1 rounded text-xs">context.secrets</code>, never in <code className="bg-white/10 px-1 rounded text-xs">globalState</code>.</p>
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
              WorkspaceGPT ships a built-in MCP (Model Context Protocol) server for GitHub Copilot and Claude Code integration.
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

          {/* ── Chrome Extension ─────────────────────────────────── */}
          <SectionAnchor id="chrome" />
          <section className="mb-16">
            <div className="mb-4"><Badge color="purple">Companion app</Badge></div>
            <SectionTitle>Chrome Extension</SectionTitle>
            <SectionSubtitle>
              A browser side-panel that lets you (or a teammate) chat with your indexed Confluence pages and Azure DevOps
              work items — without opening VS Code. It runs entirely in the browser, talking directly to your providers;
              there&apos;s no WorkspaceGPT server in between.
            </SectionSubtitle>

            <div className="grid sm:grid-cols-3 gap-4 mb-8">
              <Card icon="🧭" title="Side panel" accent="purple">
                <p>Ask questions and read grounded answers from a panel docked in Chrome.</p>
              </Card>
              <Card icon="🔗" title="One share code" accent="brand">
                <p>Connect by pasting a single code generated in VS Code — no separate setup.</p>
              </Card>
              <Card icon="🚫" title="No server" accent="green">
                <p>Calls go browser → Gemini / Qdrant / your chat model directly. Nothing is proxied.</p>
              </Card>
            </div>

            <h3 className="text-lg font-semibold text-white mb-3">Prerequisites</h3>
            <p className="text-slate-300 text-sm leading-relaxed mb-4">
              Because the browser needs cloud-reachable services, the share flow requires:{" "}
              <strong className="text-white">Gemini embeddings</strong>, a{" "}
              <strong className="text-white">Qdrant Cloud</strong> vector store, and a{" "}
              <strong className="text-white">chat model</strong> with an API key — all configured in VS Code first
              (see <a href="#embeddings" className="text-brand hover:underline">Embeddings &amp; Vector Storage</a>).
            </p>

            <h3 className="text-lg font-semibold text-white mb-4">Setup</h3>
            <div className="space-y-0">
              <Step number={1} title="Install from the Chrome Web Store">
                <p>
                  Add{" "}
                  <a href="https://chromewebstore.google.com/detail/workspacegpt/gagogpeepmgaljpabdlpbcknjnbcaole" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                    WorkspaceGPT for Chrome
                  </a>{" "}
                  to your browser.
                </p>
              </Step>
              <Step number={2} title="Create a share code in VS Code">
                <p>In the WorkspaceGPT sidebar, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Share to Chrome</code> and click <strong className="text-white">Create share code</strong>. It&apos;s copied to your clipboard.</p>
                <p className="text-slate-400">If a prerequisite is missing, the button tells you exactly what to fix first.</p>
              </Step>
              <Step number={3} title="Paste it into the extension">
                <p>Open the Chrome side panel → <strong className="text-white">Settings</strong> → paste the code → <strong className="text-white">Connect</strong>. You&apos;ll see a confirmation with your Qdrant URL.</p>
              </Step>
              <Step number={4} title="Ask away">
                <p>Close settings and chat. The extension mirrors VS Code&apos;s retrieval, so answers stay consistent across Confluence and ADO.</p>
              </Step>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <div className="p-5 bg-slate-900 border border-red-500/20 rounded-2xl text-sm">
                <p className="text-red-400 font-semibold mb-1">Treat the share code like a password</p>
                <p className="text-slate-400">It contains your real Qdrant, Gemini, and chat-model API keys in plain form. Anyone with it can query your data and incur API costs. Share only with people you trust.</p>
              </div>
              <div className="p-5 bg-slate-900 border border-emerald-500/20 rounded-2xl text-sm">
                <p className="text-emerald-400 font-semibold mb-1">Write creds are never shared</p>
                <p className="text-slate-400">GitHub, Vercel, Confluence, and ADO tokens stay in VS Code secret storage and are excluded from the bundle. The share is read-only knowledge access.</p>
              </div>
            </div>

            <div className="mt-4 p-5 bg-slate-900 border border-white/5 rounded-2xl text-sm text-slate-300">
              <span className="text-slate-200 font-semibold">Scope:</span> the extension covers <strong className="text-white">Confluence</strong> and <strong className="text-white">Azure DevOps</strong> knowledge. Local codebase indexing stays in VS Code and is not part of the share. Regenerate the code if you rotate your keys.
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
                  problem: "Codebase indexing is slow",
                  fix: "Large repos with many files take longer. Indexing is incremental after the first run. Exclude large generated/build directories by adding them to .gitignore.",
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
