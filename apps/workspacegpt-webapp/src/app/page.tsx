"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "./_components/Icon";
import { SiteNav } from "./_components/SiteNav";
import { Reveal } from "./_components/Reveal";

/** Published by .github/workflows/desktop-publish.yml on every desktop-v* tag. */
const DESKTOP_INSTALL = [
  {
    os: "macOS",
    where: "Terminal",
    command: "curl -fsSL https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.sh | sh",
  },
  {
    os: "Windows",
    where: "PowerShell",
    command: "irm https://github.com/ritesh-kant/workspaceGPT/releases/download/desktop-latest/install.ps1 | iex",
  },
] as const;
const DESKTOP_RELEASES_URL = "https://github.com/ritesh-kant/workspaceGPT/releases?q=desktop-v&expanded=true";

export default function Home() {
  const [showVSCodeOpenedMessage, setShowVSCodeOpenedMessage] = useState(false);
  const [showCursorOpenedMessage, setShowCursorOpenedMessage] = useState(false);
  const [showAntigravityOpenedMessage, setShowAntigravityOpenedMessage] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);

  const [showFallbackLink, setShowFallbackLink] = useState(false);
  const [showCursorFallbackLink, setShowCursorFallbackLink] = useState(false);
  const [showAntigravityFallbackLink, setShowAntigravityFallbackLink] = useState(false);

  const openInstallModal = () => setShowInstallModal(true);
  const closeInstallModal = () => setShowInstallModal(false);

  const openVSCode = () => {
    window.open('vscode:extension/Riteshkant.workspacegpt-extension');
    setShowVSCodeOpenedMessage(true);
    setShowFallbackLink(true);
    setShowInstallModal(false);
    setTimeout(() => setShowVSCodeOpenedMessage(false), 5000);
  };

  const openCursor = () => {
    window.open('cursor:extension/Riteshkant.workspacegpt-extension');
    setShowCursorOpenedMessage(true);
    setShowCursorFallbackLink(true);
    setShowInstallModal(false);
    setTimeout(() => setShowCursorOpenedMessage(false), 5000);
  };

  const openDesktop = () => {
    // The desktop app isn't an extension: send the visitor to the install
    // section (one-line installers + downloads) rather than a protocol handler.
    setShowInstallModal(false);
    document.getElementById("install")?.scrollIntoView({ behavior: "smooth" });
  };

  const [copied, setCopied] = useState<string | null>(null);
  const copyInstallCommand = (command: string) => {
    navigator.clipboard?.writeText(command).then(() => {
      setCopied(command);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const openAntigravity = () => {
    // Antigravity is a VS Code fork; the IDE registers the "antigravity-ide" protocol
    // (the bare "antigravity" scheme belongs to the separate Antigravity agent app).
    // It resolves the extension from Open VSX (not the MS Marketplace). If the protocol
    // handler isn't registered, the fallback link below points to the Open VSX page.
    window.open('antigravity-ide:extension/Riteshkant.workspacegpt-extension');
    setShowAntigravityOpenedMessage(true);
    setShowAntigravityFallbackLink(true);
    setShowInstallModal(false);
    setTimeout(() => setShowAntigravityOpenedMessage(false), 5000);
  };

  return (
    <div className="flex flex-col min-h-screen relative bg-background text-muted">
      <Reveal />
      <SiteNav onInstall={openInstallModal} />

      {/* Install Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 transition-opacity">
          <div className="bg-surface border border-line rounded-xl shadow-2xl p-6 sm:p-8 max-w-md w-full mx-4 relative overflow-hidden">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-medium text-foreground tracking-tight">Install WorkspaceGPT</h2>
              <button onClick={closeInstallModal} className="text-muted hover:text-white transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-muted mb-6 font-medium">Add it to your editor, or run it as an app</p>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-line transition-all duration-300">
                <div className="flex items-center gap-4">
                  <div className="bg-surface-2 p-2 rounded-lg border border-line">
                    <Image src="/vscode-icon.svg" alt="VS Code" width={28} height={28} />
                  </div>
                  <span className="font-semibold text-white">VS Code</span>
                </div>
                <button onClick={openVSCode} className="bg-brand-blue hover:bg-blue-500 text-white font-medium py-2 px-5 rounded-lg transition-colors text-sm">
                  Install
                </button>
              </div>
              
              <div className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-line transition-all duration-300">
                <div className="flex items-center gap-4">
                  <div className="bg-surface-2 p-2 rounded-lg border border-line">
                    <Image src="/cursor-icon.png" alt="Cursor" width={28} height={28} />
                  </div>
                  <span className="font-semibold text-white">Cursor</span>
                </div>
                <button onClick={openCursor} className="bg-brand-blue hover:bg-blue-500 text-white font-medium py-2 px-5 rounded-lg transition-colors text-sm">
                  Install
                </button>
              </div>

              <div className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-line transition-all duration-300">
                <div className="flex items-center gap-4">
                  <div className="bg-surface-2 p-2 rounded-lg border border-line flex items-center justify-center" style={{ width: 44, height: 44 }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-brand">
                      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
                      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
                    </svg>
                  </div>
                  <span className="font-semibold text-white">Antigravity</span>
                </div>
                <button onClick={openAntigravity} className="bg-brand-blue hover:bg-blue-500 text-white font-medium py-2 px-5 rounded-lg transition-colors text-sm">
                  Install
                </button>
              </div>

              <div className="pt-2">
                <p className="text-xs text-faint mb-3">No editor? The same agent, as an app</p>
                <div className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-line transition-all duration-300">
                  <div className="flex items-center gap-4">
                    <div className="bg-surface-2 p-2 rounded-lg border border-line flex items-center justify-center text-brand" style={{ width: 44, height: 44 }}>
                      <Icon name="laptop" size={26} />
                    </div>
                    <div>
                      <span className="font-semibold text-white block">WorkspaceGPT Desktop</span>
                      <span className="text-xs text-faint">macOS &middot; Windows</span>
                    </div>
                  </div>
                  <button onClick={openDesktop} className="bg-brand-blue hover:bg-blue-500 text-white font-medium py-2 px-5 rounded-lg transition-colors text-sm whitespace-nowrap">
                    Get the app
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      <header className="py-16 sm:py-24 relative lg:py-32">
        {/* Messages */}
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-30 w-full max-w-2xl px-4">
            {showVSCodeOpenedMessage && (
            <div className="bg-surface-2/90 backdrop-blur border border-brand/30 text-white px-6 py-4 rounded-xl shadow-2xl mb-4 text-center">
                <p className="text-sm">Attempting to open WorkspaceGPT in VS Code. Please ensure VS Code is installed.</p>
                {showFallbackLink && (
                <p className="mt-2 text-xs">
                    <a href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Or open directly in browser →</a>
                </p>
                )}
            </div>
            )}
            {showCursorOpenedMessage && (
            <div className="bg-surface-2/90 backdrop-blur border border-brand/30 text-white px-6 py-4 rounded-xl shadow-2xl text-center">
                <p className="text-sm">Attempting to open WorkspaceGPT in Cursor. Please ensure Cursor is installed.</p>
                {showCursorFallbackLink && (
                <p className="mt-2 text-xs">
                    <a href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Or open directly in browser →</a>
                </p>
                )}
            </div>
            )}
            {showAntigravityOpenedMessage && (
            <div className="bg-surface-2/90 backdrop-blur border border-brand/30 text-white px-6 py-4 rounded-xl shadow-2xl text-center">
                <p className="text-sm">Attempting to open WorkspaceGPT in Antigravity. Please ensure Antigravity is installed.</p>
                {showAntigravityFallbackLink && (
                <p className="mt-2 text-xs">
                    <a href="https://open-vsx.org/extension/Riteshkant/workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Or install from Open VSX →</a>
                </p>
                )}
            </div>
            )}
        </div>

        <div className="container mx-auto px-6 relative z-10">
          <div className="flex flex-col lg:flex-row items-center justify-between gap-8 lg:gap-12">
            <div className="lg:w-1/2 md:mb-0 text-center lg:text-left">
              <Link href="#install" className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand text-sm font-medium mb-6 sm:mb-8 hover:bg-brand/15 transition-colors">
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-brand"></span>
                </span>
                New: WorkspaceGPT Desktop for macOS and Windows &mdash; no editor required
              </Link>
              <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-[4.5rem] font-normal tracking-tight mb-6 sm:mb-8 leading-[1.05] text-foreground">
                The coding agent that knows <span className="text-brand">your whole org</span>
              </h1>
              <p className="text-lg sm:text-xl text-muted mb-8 sm:mb-10 max-w-2xl mx-auto lg:mx-0 leading-relaxed text-balance">
                It searches and reads your code, edits files, and runs your tests &mdash; grounded in your Confluence docs and your Jira and Azure DevOps tickets, not just your repo. Every change is a diff you approve first, and your connected knowledge and its search index <span className="text-white font-medium">never leave your machine</span>.
              </p>
              
              <div className="flex flex-wrap gap-4 justify-center lg:justify-start">
                <button
                  onClick={openInstallModal}
                  className="bg-brand hover:bg-[#3df5c2] text-black font-medium px-6 py-3 rounded-lg transition-colors flex items-center gap-3"
                >
                  <div className="flex items-center rounded-full bg-black/10 px-2 py-1">
                    <Image src="/vscode-icon.svg" alt="VS Code" width={18} height={18} className="drop-shadow-sm" />
                    <span className="mx-1 opacity-50 text-xs font-bold">+</span>
                    <Image src="/cursor-icon.png" alt="Cursor" width={18} height={18} className="drop-shadow-sm" />
                  </div>
                  <span>Install Extension</span>
                </button>
                <Link
                  href="#install"
                  className="bg-surface hover:bg-surface-2 border border-line hover:border-line-strong text-foreground font-medium px-6 py-3 rounded-lg transition-colors flex items-center gap-2"
                >
                  <Icon name="download" size={18} />
                  Get the desktop app
                </Link>
                <Link
                  href="#modes"
                  className="text-muted hover:text-foreground font-medium px-2 py-3 transition-colors"
                >
                  How privacy works &rarr;
                </Link>
              </div>
            </div>
            
            <div className="lg:w-1/2 flex justify-center lg:justify-end">
              <div className="relative w-full max-w-md lg:max-w-lg">
                <div className="relative w-full bg-surface border border-line rounded-xl shadow-2xl overflow-hidden flex flex-col">
                  {/* Mockup Header */}
                  <div className="h-10 border-b border-line bg-background flex items-center px-4 gap-2">
                    <div className="w-3 h-3 rounded-full bg-rose-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
                    <div className="mx-auto text-xs text-faint font-medium tracking-wide">WorkspaceGPT</div>
                  </div>
                  {/* The extension's own sidebar, captured from the real webview.
                      Cropped to the top of the transcript, so the answer runs past
                      the bottom edge — the gradient below fades it out rather than
                      ending on a hard cut through a sentence. */}
                  <div className="relative">
                    <Image
                      src="/screenshots/hero-grounded-answer.png"
                      alt="The WorkspaceGPT sidebar answering “Why is the payment retry capped at 3?” — it searched Confluence and the codebase, then cited the Retry &amp; Backoff Policy page, src/payments/retryPolicy.ts and Azure DevOps work item #12359."
                      width={880}
                      height={1080}
                      className="w-full h-auto"
                      priority
                    />
                    <div
                      className="absolute inset-x-0 bottom-0 h-24 pointer-events-none"
                      style={{ background: "linear-gradient(to top, #1f1f1f, rgba(31,31,31,0))" }}
                    ></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow z-10 relative">

        {/* Privacy Highlight Row */}
        <section className="py-12 border-y border-line bg-surface/40">
          <div className="container mx-auto px-6">
            <div className="flex flex-col md:flex-row items-start justify-center gap-10 md:gap-16 text-center">
              <div className="flex flex-col items-center max-w-xs mx-auto">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-4 border border-emerald-500/20"><Icon name="laptop" /></div>
                <h3 className="text-lg font-semibold text-white mb-2">Your data stays on your machine</h3>
                <p className="text-muted text-sm">Indexing and embeddings run on-device, and the vector index is written to local files. We never upload your documents or your code.</p>
              </div>
              <div className="hidden md:block w-px h-20 bg-gradient-to-b from-transparent via-white/10 to-transparent"></div>
              <div className="flex flex-col items-center max-w-xs mx-auto">
                <div className="w-12 h-12 rounded-full bg-brand/10 text-brand flex items-center justify-center mb-4 border border-brand/20"><Icon name="trash" /></div>
                <h3 className="text-lg font-semibold text-white mb-2">Zero data retention</h3>
                <p className="text-muted text-sm">We store no prompts, no answers, no documents &mdash; not even in logs. In Remote mode your question is processed in memory and discarded.</p>
              </div>
              <div className="hidden md:block w-px h-20 bg-gradient-to-b from-transparent via-white/10 to-transparent"></div>
              <div className="flex flex-col items-center max-w-xs mx-auto">
                <div className="w-12 h-12 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center mb-4 border border-blue-500/20"><Icon name="eye-off" /></div>
                <h3 className="text-lg font-semibold text-white mb-2">Never used for training</h3>
                <p className="text-muted text-sm">Nothing you ask is used to train a model, sold, or shared. Anonymous feature-usage counts are all we measure &mdash; never your content.</p>
              </div>
            </div>
            <p className="text-center text-faint text-sm mt-8">
              Read the full{" "}
              <Link href="/privacy" className="text-brand hover:underline">privacy policy</Link>{" "}
              &mdash; it lists every byte we hold.
            </p>
          </div>
        </section>

        {/* Two Modes */}
        <section data-reveal id="modes" className="py-16 sm:py-24 border-b border-line">
          <div className="container mx-auto px-6 max-w-5xl">
            <div className="text-center mb-12 sm:mb-16">
              <h2 className="text-3xl sm:text-5xl font-normal text-foreground mb-4 tracking-tight">Two modes, one guarantee</h2>
              <p className="text-muted text-base sm:text-lg max-w-2xl mx-auto">
                The mode changes exactly one thing: <span className="text-white font-medium">where the answer is generated</span>.
                Your docs and tickets, and the search index built from them, stay local either way.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Local */}
              <div className="bg-surface border border-line rounded-xl p-8 hover:border-line-strong transition-colors duration-500 relative overflow-hidden flex flex-col">
                <div className="relative z-10 flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <Icon name="lock" size={22} />
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">Local &middot; Free</span>
                  </div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Everything runs locally</h3>
                  <p className="text-muted leading-relaxed mb-6">
                    Your model, your hardware. With Ollama, none of your content leaves your computer &mdash; no
                    account, no cloud round-trip. Prefer a bigger model? Plug in your own provider key and you still
                    decide exactly where your data goes.
                  </p>
                  <ul className="space-y-2.5 text-sm text-muted">
                    <li className="flex gap-3"><span className="text-emerald-400 flex-shrink-0">✓</span> Chat model on your machine via Ollama &mdash; or your own API key</li>
                    <li className="flex gap-3"><span className="text-emerald-400 flex-shrink-0">✓</span> Embeddings generated on-device</li>
                    <li className="flex gap-3"><span className="text-emerald-400 flex-shrink-0">✓</span> Vector index in local files</li>
                    <li className="flex gap-3"><span className="text-emerald-400 flex-shrink-0">✓</span> No account &mdash; runs offline with a local model</li>
                  </ul>
                </div>
              </div>

              {/* Remote */}
              <div className="bg-surface border border-line rounded-xl p-8 hover:border-line-strong transition-colors duration-500 relative overflow-hidden flex flex-col">
                <div className="relative z-10 flex-1">
                  <div className="flex items-center gap-3 mb-4">
                    <Icon name="zap" size={22} />
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-brand/10 text-brand border-brand/20">Remote &middot; Preview</span>
                  </div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">We run the infrastructure</h3>
                  <p className="text-muted leading-relaxed mb-6">
                    We host the inference and choose the model, so there is nothing to configure and no model key to
                    buy. Your data still stays local: only your question and the snippets retrieved for it reach our
                    endpoint &mdash; and we keep none of it.
                  </p>
                  <ul className="space-y-2.5 text-sm text-muted">
                    <li className="flex gap-3"><span className="text-brand flex-shrink-0">✓</span> Managed model &mdash; no provider keys, no setup</li>
                    <li className="flex gap-3"><span className="text-brand flex-shrink-0">✓</span> Embeddings <em className="text-white not-italic font-medium">still</em> generated on-device</li>
                    <li className="flex gap-3"><span className="text-brand flex-shrink-0">✓</span> Vector index <em className="text-white not-italic font-medium">still</em> in local files</li>
                    <li className="flex gap-3"><span className="text-brand flex-shrink-0">✓</span> Sign in with GitHub; every request re-verified</li>
                    <li className="flex gap-3"><span className="text-brand flex-shrink-0">✓</span> Zero retention &mdash; nothing stored, nothing logged</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="mt-6 p-5 bg-surface border border-yellow-500/20 rounded-xl text-sm text-muted">
              <span className="text-yellow-400 font-semibold">Remote mode is in preview.</span>{" "}
              It is rolling out now and may change while we tune capacity and models. Local mode is generally
              available and is unaffected. Inference in Remote mode is performed by an upstream model provider under
              its own policy &mdash; see the{" "}
              <Link href="/privacy" className="text-brand hover:underline">privacy policy</Link> for exactly what
              travels where.
            </div>
          </div>
        </section>

        {/* Features Bento Grid */}
        <section data-reveal id="features" className="pt-16 pb-8 sm:pt-24 sm:pb-12">
          <div className="container mx-auto px-6">
            <div className="text-center mb-12 sm:mb-16">
              <h2 className="text-3xl sm:text-5xl font-normal text-foreground mb-4 tracking-tight">Capabilities designed for builders</h2>
              <p className="text-muted text-base sm:text-lg max-w-2xl mx-auto">A full agent that reads, edits and verifies &mdash; with the docs and tickets that explain <span className="text-white font-medium">why</span> already in reach.</p>
            </div>
            
            <div className="grid md:grid-cols-3 gap-6 auto-rows-fr">
              {/* Feature 1 */}
              <div className="md:col-span-2 bg-surface border border-line p-8 rounded-xl hover:border-line-strong transition-colors duration-500 relative overflow-hidden">
                <div className="relative z-10">
                  <div className="w-14 h-14 rounded-xl bg-white/5 border border-line flex items-center justify-center mb-6 shadow-inner text-brand"><Icon name="sparkles" size={26} /></div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Agentic coding</h3>
                  <p className="text-muted text-base sm:text-lg leading-relaxed max-w-lg">The agent searches and reads your code, makes multi-file edits, then runs your linter, type-checker and tests to verify its own work before handing it back.</p>
                </div>
              </div>
              
              {/* Feature 2 */}
              <div className="bg-surface border border-line p-8 rounded-xl hover:border-line-strong transition-colors duration-500 relative overflow-hidden">
                <div className="relative z-10">
                  <div className="w-14 h-14 rounded-xl bg-white/5 border border-line flex items-center justify-center mb-6 text-blue-400"><Icon name="file-text" size={26} /></div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Your org&apos;s knowledge</h3>
                  <p className="text-muted">Confluence pages, Jira issues and Azure DevOps work items, synced and searchable. A run is grounded in the design page and the ticket that asked for it, not just the file.</p>
                </div>
              </div>

              {/* Feature 3 */}
              <div className="bg-surface border border-line p-8 rounded-xl hover:border-line-strong transition-colors duration-500 relative overflow-hidden">
                <div className="relative z-10">
                  <div className="w-14 h-14 rounded-xl bg-white/5 border border-line flex items-center justify-center mb-6 text-purple-400"><Icon name="laptop" size={26} /></div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">In your editor, or on its own</h3>
                  <p className="text-muted">Install it in VS Code, Cursor or Antigravity &mdash; or run WorkspaceGPT Desktop, the same agent as an app for macOS and Windows. Open a folder and go.</p>
                </div>
              </div>

              {/* Feature 4 */}
              <div className="md:col-span-2 bg-surface border border-line p-8 rounded-xl hover:border-line-strong transition-colors duration-500 group flex flex-col md:flex-row gap-8 items-center relative overflow-hidden">
                <div className="absolute bottom-0 left-0 w-full h-32 bg-gradient-to-t from-black/20 to-transparent"></div>
                <div className="flex-1 relative z-10">
                  <div className="w-14 h-14 rounded-xl bg-white/5 border border-line flex items-center justify-center mb-6 text-brand"><Icon name="shield-check" size={26} /></div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Review before it writes</h3>
                  <p className="text-muted text-base sm:text-lg leading-relaxed">Every file change arrives as a diff you approve or reject. A checkpoint is taken before the first write, so one click reverts the whole turn.</p>
                </div>
              </div>
            </div>

            {/* The rest of the surface, at a glance. */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
              {[
                {
                  icon: "search" as const,
                  title: "Codebase understanding",
                  body: "ripgrep search plus symbol, definition and reference lookup through a real language server — your editor's, or the one bundled with Desktop.",
                },
                {
                  icon: "clipboard-list" as const,
                  title: "Your work, on open",
                  body: "The sidebar lists the ADO items assigned to you with their state and sprint — start a run straight from a ticket.",
                },
                {
                  icon: "search" as const,
                  title: "Web search mid-task",
                  body: "Lets the agent look up what your code and docs can't tell it: a new library, an unfamiliar API, current release notes.",
                },
                {
                  icon: "at-sign" as const,
                  title: "@-mentions",
                  body: "Pull a specific file or folder into the conversation instead of hoping retrieval finds it.",
                },
                {
                  icon: "git-branch" as const,
                  title: "Release automation",
                  body: "Config-sync and hotfix pipelines with a plan → approve → apply flow, so work doesn't stop at “PR opened”.",
                },
                {
                  icon: "plug" as const,
                  title: "MCP server",
                  body: "Ships an MCP server that exposes your Confluence, Jira and Azure DevOps search to Claude Desktop, Cursor and other MCP clients.",
                },
                {
                  icon: "wifi-off" as const,
                  title: "Runs offline",
                  body: "In Local mode with Ollama there are no remote APIs at all — the whole loop works on a plane.",
                },
                {
                  icon: "message-square" as const,
                  title: "Chat where you want it",
                  body: "Run it in the sidebar or open it as a full editor tab, with several sessions going at once.",
                },
              ].map((f) => (
                <div
                  key={f.title}
                  className="bg-surface border border-line rounded-xl p-5 hover:border-line-strong transition-colors"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-brand"><Icon name={f.icon} size={18} /></span>
                    <h3 className="font-semibold text-white">{f.title}</h3>
                  </div>
                  <p className="text-muted text-sm leading-relaxed">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Product shots. These are 2x captures of a ~384pt sidebar, so they are
            displayed at ~384px wide — 1:1 physical size, as legible here as in
            the editor. Don't stretch them past that. */}
        <section data-reveal id="see-it" className="py-16 sm:py-24 border-t border-line">
          <div className="container mx-auto px-6">
            <div className="text-center mb-12 sm:mb-16">
              <h2 className="text-3xl sm:text-5xl font-normal text-foreground mb-4 tracking-tight">From an assigned ticket to a verified answer</h2>
              <p className="text-muted text-base sm:text-lg max-w-2xl mx-auto">Open the sidebar and your work is already there. Pick a ticket and the agent takes it from the docs to the code to the test run.</p>
            </div>

            {/* The wide one carries the whole loop, so it leads and runs full width. */}
            <figure className="mb-14 sm:mb-20 max-w-6xl mx-auto">
              <div className="rounded-xl overflow-hidden border border-line shadow-2xl bg-background">
                <Image
                  src="/screenshots/agent-run-wide.jpg"
                  alt="WorkspaceGPT open as a full editor tab, working bug #248721 “Authentication token not refreshing after session”. Five completed steps — analyse, plan, implement, run tests, verify — show the files it modified, unit 12/12, integration 5/5 and e2e 3/3 passing, and the task completed in 1 minute 5 seconds."
                  width={1376}
                  height={768}
                  className="w-full h-auto"
                />
              </div>
              <figcaption className="text-muted text-sm mt-4 leading-relaxed text-center max-w-3xl mx-auto">
                <span className="text-white font-medium">One bug, start to finish.</span> It plans the fix, edits the files, runs the unit, integration and end-to-end suites, then re-checks the original failing scenario &mdash; and hands you a diff.
              </figcaption>
            </figure>

            <div className="flex flex-col md:flex-row gap-10 md:gap-12 justify-center items-start">
              <figure className="w-full max-w-[384px] mx-auto md:mx-0">
                <div className="rounded-xl overflow-hidden border border-line shadow-2xl bg-background">
                  <Image
                    src="/screenshots/sidebar-your-work.jpg"
                    alt="The WorkspaceGPT sidebar on open: a “Your work” list of assigned Azure DevOps items with their type, state and sprint, recent chats below it, and a suggested “Fix #1829411” action."
                    width={768}
                    height={1344}
                    className="w-full h-auto"
                  />
                </div>
                <figcaption className="text-muted text-sm mt-4 leading-relaxed">
                  <span className="text-white font-medium">Your work, already loaded.</span> The items assigned to you, with state and sprint &mdash; no hunting for a ticket ID to paste in.
                </figcaption>
              </figure>

              <figure className="w-full max-w-[384px] mx-auto md:mx-0">
                <div className="rounded-xl overflow-hidden border border-line shadow-2xl bg-background">
                  <Image
                    src="/screenshots/agent-run-verified.jpg"
                    alt="An agent run grounded in user story #4598: after 63 steps it reports “No change needed — the caching logic for user profiles is already implemented in the service layer”, cites the files and line ranges it read, and shows three cache tests passing."
                    width={768}
                    height={1376}
                    className="w-full h-auto"
                  />
                </div>
                <figcaption className="text-muted text-sm mt-4 leading-relaxed">
                  <span className="text-white font-medium">It will tell you there is nothing to do.</span> Sixty-three steps, every file it read cited, and the tests run to prove it &mdash; rather than inventing a change to look busy.
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        {/* Install: the editor extension and the desktop app side by side. SiteNav
            links here (/#install) from every page. */}
        <section data-reveal id="install" className="py-16 sm:py-24 border-t border-line">
          <div className="container mx-auto px-6 max-w-5xl">
            <div className="text-center mb-12 sm:mb-16">
              <h2 className="text-3xl sm:text-5xl font-normal text-foreground mb-4 tracking-tight">Run it where you work</h2>
              <p className="text-muted text-base sm:text-lg max-w-2xl mx-auto">
                The same agent, the same knowledge and the same privacy guarantees &mdash; in your editor, or as an app of its own.
              </p>
            </div>

            <div className="grid md:grid-cols-2 gap-6">
              {/* Desktop */}
              <div className="bg-surface border border-line rounded-xl p-8 hover:border-line-strong transition-colors duration-500 flex flex-col">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-brand"><Icon name="laptop" size={22} /></span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-brand/10 text-brand border-brand/20">New &middot; macOS &middot; Windows</span>
                </div>
                <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">WorkspaceGPT Desktop</h3>
                <p className="text-muted leading-relaxed mb-6">
                  No editor needed. Open a project folder and the agent reads, edits and tests it, with your Confluence,
                  Jira and Azure DevOps knowledge in reach. Paste one line:
                </p>
                {DESKTOP_INSTALL.map((d) => (
                  <div key={d.os} className="mb-3">
                    <p className="text-xs text-faint mb-1.5">
                      <span className="text-foreground font-medium">{d.os}</span> &middot; {d.where}
                    </p>
                    <div className="bg-background border border-line rounded-xl p-3 pl-4 font-mono text-xs sm:text-sm text-brand-blue flex items-start justify-between gap-3">
                      <code className="break-all leading-relaxed">{d.command}</code>
                      <button
                        onClick={() => copyInstallCommand(d.command)}
                        aria-label={`Copy the ${d.os} install command`}
                        className="shrink-0 text-faint hover:text-foreground transition-colors p-1"
                      >
                        <Icon name={copied === d.command ? "check" : "copy"} size={18} />
                      </button>
                    </div>
                  </div>
                ))}
                <ul className="space-y-2.5 text-sm text-muted mt-4 mb-6">
                  <li className="flex gap-3"><span className="text-brand flex-shrink-0"><Icon name="check" size={16} /></span> Apple Silicon and Intel Macs (macOS 12+), and Windows x64</li>
                  <li className="flex gap-3"><span className="text-brand flex-shrink-0"><Icon name="refresh" size={16} /></span> Updates itself &mdash; every update is signed and verified before it installs</li>
                  <li className="flex gap-3"><span className="text-brand flex-shrink-0"><Icon name="lock" size={16} /></span> Secrets in the macOS Keychain or Windows Credential Manager; indexes stay on your machine</li>
                </ul>
                <div className="mt-auto">
                  <a
                    href={DESKTOP_RELEASES_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-brand hover:underline"
                  >
                    <Icon name="download" size={16} /> Prefer a DMG or setup.exe? Download it from GitHub
                  </a>
                  <p className="text-xs text-faint mt-2 leading-relaxed">
                    The app isn&apos;t notarized or code-signed yet. The one-line installers need nothing extra.
                    A DMG needs one &ldquo;Open Anyway&rdquo; in System Settings &rsaquo; Privacy &amp; Security; a
                    browser-downloaded setup.exe needs &ldquo;More info &rsaquo; Run anyway&rdquo;. Linux is on the way.
                  </p>
                </div>
              </div>

              {/* Editor extension */}
              <div className="bg-surface border border-line rounded-xl p-8 hover:border-line-strong transition-colors duration-500 flex flex-col">
                <div className="flex items-center gap-3 mb-4">
                  <span className="text-brand-blue"><Icon name="sparkles" size={22} /></span>
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border bg-blue-500/10 text-blue-400 border-blue-500/20">VS Code &middot; Cursor &middot; Antigravity</span>
                </div>
                <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Editor extension</h3>
                <p className="text-muted leading-relaxed mb-6">
                  Lives in your editor&apos;s sidebar or a full editor tab, and uses your editor&apos;s own language server
                  for symbol lookups. From the VS Code Marketplace, or Open VSX for Cursor and Antigravity.
                </p>
                <div className="bg-background border border-line rounded-xl p-3 pl-4 font-mono text-xs sm:text-sm text-brand-blue mb-6">
                  <code>ext install Riteshkant.workspacegpt-extension</code>
                </div>
                <div className="mt-auto">
                  <button
                    onClick={openInstallModal}
                    className="bg-brand hover:bg-[#3df5c2] text-black font-medium px-5 py-2.5 rounded-lg transition-colors text-sm"
                  >
                    Install in your editor
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Setup & Installation Guide */}
        <section id="getting-started" className="py-6 sm:py-10 border-t border-line bg-background">
          <div className="container mx-auto px-6 max-w-5xl">
            <h2 className="text-3xl sm:text-4xl font-bold text-center mb-12 sm:mb-16 tracking-tight">Ready in minutes</h2>
            
            <div className="grid md:grid-cols-2 gap-12 lg:gap-20">
              
              {/* Column 1: Installation */}
              <div className="space-y-10">
                <div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand font-bold">1</div>
                    <h3 className="text-2xl font-semibold text-white">Installation</h3>
                  </div>
                  <div className="pl-12 space-y-4 text-muted">
                    <p>
                      Add the extension to VS Code, Cursor or Antigravity, or install{" "}
                      <Link href="#install" className="text-brand hover:underline">WorkspaceGPT Desktop</Link> on a Mac.
                    </p>
                    <div className="bg-surface border border-line rounded-xl p-4 font-mono text-sm text-brand-blue">
                      <span>ext install Riteshkant.workspacegpt-extension</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand font-bold">2</div>
                    <h3 className="text-2xl font-semibold text-white">Pick your mode</h3>
                  </div>
                  <div className="pl-12 text-muted space-y-4">
                    <p>Open <code className="bg-white/10 text-slate-200 px-2 rounded">Settings {`>`} Mode</code>. Either way, indexing stays on your machine.</p>
                    <ul className="space-y-4">
                      <li className="flex items-start gap-3">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0 mt-[0.4rem]"></div>
                        <div className="leading-relaxed">
                          <span className="font-medium text-slate-200">Local</span> &mdash; bring your own model. Ollama for fully offline (default{" "}
                          <code className="font-mono text-xs bg-white/10 px-1 py-0.5 rounded text-muted">llama3.2:1b</code>), or your own
                          OpenAI / Claude / Gemini / Groq / OpenRouter key &mdash; or any OpenAI-compatible endpoint.
                        </div>
                      </li>
                      <li className="flex items-start gap-3">
                        <div className="w-2 h-2 rounded-full bg-brand flex-shrink-0 mt-[0.4rem]"></div>
                        <div className="leading-relaxed">
                          <span className="font-medium text-slate-200">Remote</span> <span className="text-xs text-brand">(preview)</span> &mdash; sign in with GitHub and we
                          handle the model. No keys, nothing to configure.
                        </div>
                      </li>
                    </ul>
                    <p className="text-sm text-muted">
                      No re-index when you switch &mdash; the mode only moves inference, never your index.
                    </p>
                  </div>
                </div>
              </div>

              {/* Column 2: Knowledge */}
              <div className="space-y-10">
                <div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand font-bold">3</div>
                    <h3 className="text-2xl font-semibold text-white">Connect your knowledge</h3>
                  </div>
                  <div className="pl-12 text-muted space-y-6">
                    <div className="bg-surface border border-line p-5 rounded-xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-full h-full bg-blue-500/5 group-hover:bg-blue-500/10 transition-colors pointer-events-none"></div>
                      <h4 className="text-blue-400 font-semibold mb-2 flex items-center gap-2">
                        Confluence and Jira
                      </h4>
                      <p className="text-sm">In <code className="bg-black/50 px-1 rounded">Settings</code>, open Confluence or Jira and click <strong>Connect</strong> to sign in with your Atlassian account. Pick a space or project and sync.</p>
                    </div>

                    <div className="bg-surface border border-line p-5 rounded-xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-full h-full bg-purple-500/5 group-hover:bg-purple-500/10 transition-colors pointer-events-none"></div>
                      <h4 className="text-purple-400 font-semibold mb-2 flex items-center gap-2">
                        Azure DevOps
                      </h4>
                      <p className="text-sm">In <code className="bg-black/50 px-1 rounded">Settings {`>`} Azure DevOps</code>, enter your organization and a Personal Access Token to sync work items and the tickets behind <em>Your work</em>.</p>
                    </div>
                  </div>
                </div>
              </div>
              
            </div>
          </div>
        </section>

      </main>

      {/* Footer */}
      <footer className="border-t border-line py-8 sm:py-12 bg-background relative">
        <div className="container mx-auto px-6 relative z-10">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 border border-line flex flex-shrink-0 items-center justify-center">
                 <Image src="/icon.png" width={20} height={20} alt="Logo" className="w-[20px] h-[20px] object-contain opacity-80" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">WorkspaceGPT</h2>
                <p className="text-faint text-sm">Your data stays yours. Zero retention.</p>
              </div>
            </div>
            
            <div className="flex gap-8 text-sm font-medium">
              <Link href="/docs" className="text-muted hover:text-white transition-colors">Docs</Link>
              <Link href="/privacy" className="text-muted hover:text-white transition-colors">Privacy</Link>
              <a href="https://github.com/ritesh-kant/workspaceGPT/issues" className="text-muted hover:text-white transition-colors">GitHub Issues</a>
              <a href="mailto:contact@workspacegpt.in" className="text-muted hover:text-white transition-colors">Contact</a>
              <a href="https://devnotes.tech/tag/workspacegpt/" className="text-muted hover:text-white transition-colors">Blog</a>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-line text-center flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-faint text-sm">© {new Date().getFullYear()} WorkspaceGPT. Proprietary Software.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
