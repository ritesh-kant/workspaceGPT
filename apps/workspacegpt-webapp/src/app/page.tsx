"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

export default function Home() {
  const [showVSCodeOpenedMessage, setShowVSCodeOpenedMessage] = useState(false);
  const [showCursorOpenedMessage, setShowCursorOpenedMessage] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);

  const [showFallbackLink, setShowFallbackLink] = useState(false);
  const [showCursorFallbackLink, setShowCursorFallbackLink] = useState(false);

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

  return (
    <div className="flex flex-col min-h-screen relative overflow-hidden bg-[#030712] text-slate-200">
      
      {/* Background glow effects */}
      <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-brand/10 blur-[150px] rounded-full pointer-events-none -z-10 animate-pulse-slow"></div>
      <div className="absolute bottom-[20%] right-[-10%] w-[500px] h-[500px] bg-brand-blue/15 blur-[120px] rounded-full pointer-events-none -z-10"></div>
      <div className="absolute top-[40%] left-[-10%] w-[400px] h-[400px] bg-purple-600/10 blur-[120px] rounded-full pointer-events-none -z-10"></div>

      {/* Install Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 transition-opacity">
          <div className="bg-slate-900 border border-white/10 rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 relative overflow-hidden">
            {/* Modal subtle glow */}
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-brand-blue to-brand"></div>
            
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">Install WorkspaceGPT</h2>
              <button onClick={closeInstallModal} className="text-slate-400 hover:text-white transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-slate-400 mb-6 font-medium">Select your preferred IDE to begin</p>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-white/10 transition-all duration-300">
                <div className="flex items-center gap-4">
                  <div className="bg-slate-800 p-2 rounded-lg border border-white/5">
                    <Image src="/vscode-icon.svg" alt="VS Code" width={28} height={28} />
                  </div>
                  <span className="font-semibold text-white">VS Code</span>
                </div>
                <button onClick={openVSCode} className="bg-brand-blue hover:bg-blue-500 text-white font-medium py-2 px-5 rounded-lg transition-colors text-sm">
                  Install
                </button>
              </div>
              
              <div className="flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-white/10 transition-all duration-300">
                <div className="flex items-center gap-4">
                  <div className="bg-slate-800 p-2 rounded-lg border border-white/5">
                    <Image src="/cursor-icon.png" alt="Cursor" width={28} height={28} />
                  </div>
                  <span className="font-semibold text-white">Cursor</span>
                </div>
                <button onClick={openCursor} className="bg-brand-blue hover:bg-blue-500 text-white font-medium py-2 px-5 rounded-lg transition-colors text-sm">
                  Install
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      <header className="py-24 relative lg:py-32">
        {/* Messages */}
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 w-full max-w-2xl px-4">
            {showVSCodeOpenedMessage && (
            <div className="bg-slate-800/90 backdrop-blur border border-brand/30 text-white px-6 py-4 rounded-xl shadow-2xl mb-4 text-center">
                <p className="text-sm">Attempting to open WorkspaceGPT in VS Code. Please ensure VS Code is installed.</p>
                {showFallbackLink && (
                <p className="mt-2 text-xs">
                    <a href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Or open directly in browser →</a>
                </p>
                )}
            </div>
            )}
            {showCursorOpenedMessage && (
            <div className="bg-slate-800/90 backdrop-blur border border-brand/30 text-white px-6 py-4 rounded-xl shadow-2xl text-center">
                <p className="text-sm">Attempting to open WorkspaceGPT in Cursor. Please ensure Cursor is installed.</p>
                {showCursorFallbackLink && (
                <p className="mt-2 text-xs">
                    <a href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">Or open directly in browser →</a>
                </p>
                )}
            </div>
            )}
        </div>

        <div className="container mx-auto px-6 relative z-10">
          <div className="flex flex-col lg:flex-row items-center justify-between gap-12">
            <div className="lg:w-1/2 md:mb-0 text-center lg:text-left">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-brand/10 border border-brand/20 text-brand text-sm font-medium mb-8">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-brand"></span>
                </span>
                WorkspaceGPT v1.0.0
              </div>
              <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-8">
                Your <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand to-brand-blue">AI-powered</span> <br/> local coding assistant
              </h1>
              <p className="text-xl text-slate-400 mb-10 max-w-2xl mx-auto lg:mx-0 leading-relaxed text-balance">
                Chat with your codebase and your Confluence docs from right inside your IDE. Designed for total privacy running 100% locally or via your own APIs.
              </p>
              
              <div className="flex flex-wrap gap-4 justify-center lg:justify-start">
                <button
                  onClick={openInstallModal}
                  className="bg-brand hover:bg-[#1ce2a7] text-black font-semibold px-8 py-4 rounded-full transition-all flex items-center gap-3 shadow-[0_0_20px_rgba(31,242,180,0.3)] hover:shadow-[0_0_30px_rgba(31,242,180,0.5)] transform hover:-translate-y-1"
                >
                  <div className="flex items-center rounded-full bg-black/10 px-2 py-1">
                    <Image src="/vscode-icon.svg" alt="VS Code" width={18} height={18} className="drop-shadow-sm" />
                    <span className="mx-1 opacity-50 text-xs font-bold">+</span>
                    <Image src="/cursor-icon.png" alt="Cursor" width={18} height={18} className="drop-shadow-sm" />
                  </div>
                  <span>Install Extension</span>
                </button>
                <Link
                  href="#features"
                  className="bg-white/5 hover:bg-white/10 border border-white/10 text-white font-medium py-4 px-8 rounded-full transition-all backdrop-blur-sm"
                >
                  Explore Features
                </Link>
              </div>
            </div>
            
            <div className="lg:w-1/2 flex justify-center lg:justify-end animate-float">
              <div className="relative w-full max-w-lg aspect-square lg:aspect-[4/3]">
                {/* Decorative UI element for the hero mockup */}
                <div className="absolute inset-0 bg-gradient-to-tr from-brand-blue/20 to-brand/20 rounded-2xl blur-2xl -z-10"></div>
                <div className="relative w-full h-full bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
                  {/* Mockup Header */}
                  <div className="h-10 border-b border-white/5 bg-slate-950 flex items-center px-4 gap-2">
                    <div className="w-3 h-3 rounded-full bg-rose-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-amber-500/80"></div>
                    <div className="w-3 h-3 rounded-full bg-emerald-500/80"></div>
                    <div className="mx-auto text-xs text-slate-500 font-medium tracking-wide">WorkspaceGPT</div>
                  </div>
                  {/* Mockup Image */}
                  <div className="relative flex-grow p-4 bg-slate-950 overflow-hidden">
                    <Image
                      src="/icon.png"
                      alt="WorkspaceGPT Logo"
                      fill
                      className="object-contain p-12 opacity-90 drop-shadow-[0_0_15px_rgba(31,242,180,0.2)]"
                      priority
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow z-10 relative">

        {/* Privacy Highlight Row */}
        <section className="py-12 border-y border-white/5 bg-slate-900/30 backdrop-blur-md">
          <div className="container mx-auto px-6">
            <div className="flex flex-col md:flex-row items-center justify-center gap-10 md:gap-20 text-center">
              <div className="flex flex-col items-center max-w-xs">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 flex items-center justify-center mb-4 text-2xl border border-emerald-500/20 shadow-[0_0_15px_rgba(16,185,129,0.15)]">🔐</div>
                <h3 className="text-lg font-semibold text-white mb-2">100% Local & Private</h3>
                <p className="text-slate-400 text-sm">Run with Ollama locally with zero data sent out. Total privacy.</p>
              </div>
              <div className="hidden md:block w-px h-20 bg-gradient-to-b from-transparent via-white/10 to-transparent"></div>
              <div className="flex flex-col items-center max-w-xs">
                <div className="w-12 h-12 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center mb-4 text-2xl border border-blue-500/20 shadow-[0_0_15px_rgba(59,130,246,0.15)]">☁️</div>
                <h3 className="text-lg font-semibold text-white mb-2">Cloud Connectors</h3>
                <p className="text-slate-400 text-sm">Hook into OpenAI, Gemini, Groq, or OpenRouter for maximum power.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Features Bento Grid */}
        <section id="features" className="py-24">
          <div className="container mx-auto px-6">
            <div className="text-center mb-16">
              <h2 className="text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400 mb-4 tracking-tight">Capabilities designed for builders</h2>
              <p className="text-slate-400 text-lg max-w-2xl mx-auto">Everything you need to navigate, understand, and build within your existing codebase seamlessly.</p>
            </div>
            
            <div className="grid md:grid-cols-3 gap-6 auto-rows-fr">
              {/* Feature 1 */}
              <div className="md:col-span-2 bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5 p-8 rounded-3xl hover:border-brand/40 transition-colors duration-500 group relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-brand/5 rounded-full blur-3xl -mx-24 -my-24 group-hover:bg-brand/10 transition-colors"></div>
                <div className="relative z-10">
                  <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl mb-6 shadow-inner text-brand">🤖</div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">AI-Powered Q&A</h3>
                  <p className="text-slate-400 text-lg leading-relaxed max-w-lg">Get context-aware answers from your local workspace using blazing fast Retrieval-Augmented Generation (RAG).</p>
                </div>
              </div>
              
              {/* Feature 2 */}
              <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5 p-8 rounded-3xl hover:border-blue-500/40 transition-colors duration-500 group relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/10 rounded-full blur-2xl group-hover:bg-blue-500/20 transition-colors"></div>
                <div className="relative z-10">
                  <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl mb-6 text-blue-400">📄</div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Confluence One-Click</h3>
                  <p className="text-slate-400">Seamlessly connect to your Confluence space and instantly start chatting with your documentation alongside your code.</p>
                </div>
              </div>

              {/* Feature 3 */}
              <div className="bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5 p-8 rounded-3xl hover:border-purple-500/40 transition-colors duration-500 group relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 rounded-full blur-2xl group-hover:bg-purple-500/20 transition-colors"></div>
                <div className="relative z-10">
                  <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl mb-6 text-purple-400">🔷</div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Azure DevOps (ADO)</h3>
                  <p className="text-slate-400">Deep integration with ADO to fetch work items, user stories, and pull requests directly into your AI context.</p>
                </div>
              </div>

              {/* Feature 4 */}
              <div className="md:col-span-2 bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5 p-8 rounded-3xl hover:border-brand/40 transition-colors duration-500 group flex flex-col md:flex-row gap-8 items-center relative overflow-hidden">
                <div className="absolute bottom-0 left-0 w-full h-32 bg-gradient-to-t from-black/20 to-transparent"></div>
                <div className="flex-1 relative z-10">
                  <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl mb-6 text-brand">💬</div>
                  <h3 className="text-2xl font-semibold mb-3 tracking-tight text-white">Interactive Editor Chat</h3>
                  <p className="text-slate-400 text-lg leading-relaxed">Ask questions directly in the IDE to receive intelligent, project-specific code solutions. Stop switching context.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Setup & Installation Guide */}
        <section id="getting-started" className="py-24 border-t border-white/5 bg-slate-950">
          <div className="container mx-auto px-6 max-w-5xl">
            <h2 className="text-4xl font-bold text-center mb-16 tracking-tight">Ready in minutes</h2>
            
            <div className="grid md:grid-cols-2 gap-12 lg:gap-20">
              
              {/* Column 1: Installation */}
              <div className="space-y-10">
                <div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand font-bold">1</div>
                    <h3 className="text-2xl font-semibold text-white">Installation</h3>
                  </div>
                  <div className="pl-12 space-y-4 text-slate-400">
                    <p>WorkspaceGPT is available directly through the marketplace. Install it for VS Code or Cursor.</p>
                    <div className="bg-slate-900 border border-white/10 rounded-xl p-4 font-mono text-sm text-brand-blue flex justify-between items-center">
                      <span>ext install Riteshkant.workspacegpt-extension</span>
                      <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand font-bold">2</div>
                    <h3 className="text-2xl font-semibold text-white">Choose Provider</h3>
                  </div>
                  <div className="pl-12 text-slate-400 space-y-4">
                    <p>Select your engine in <code className="bg-white/10 text-slate-200 px-2 rounded">Settings {`>`} Providers</code>.</p>
                    <ul className="space-y-3">
                      <li className="flex items-center gap-3"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> <span className="font-medium text-slate-300">Ollama (100% Local)</span> - Default: <code className="text-xs">llama3.2:1b</code></li>
                      <li className="flex items-center gap-3"><div className="w-2 h-2 rounded-full bg-blue-500"></div> <span className="font-medium text-slate-300">OpenAI / Gemini</span> - High performance models</li>
                      <li className="flex items-center gap-3"><div className="w-2 h-2 rounded-full bg-purple-500"></div> <span className="font-medium text-slate-300">OpenRouter</span> - Multiple model access</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Column 2: Integrations */}
              <div className="space-y-10">
                <div>
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center justify-center w-8 h-8 rounded-full bg-brand/20 text-brand font-bold">3</div>
                    <h3 className="text-2xl font-semibold text-white">Connect Contexts</h3>
                  </div>
                  <div className="pl-12 text-slate-400 space-y-6">
                    <div className="bg-slate-900 border border-white/5 p-5 rounded-2xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-full h-full bg-blue-500/5 group-hover:bg-blue-500/10 transition-colors pointer-events-none"></div>
                      <h4 className="text-blue-400 font-semibold mb-2 flex items-center gap-2">
                         Confluence Start
                      </h4>
                      <p className="text-sm">Go to <code className="bg-black/50 px-1 rounded">Settings {`>`} Confluence</code>. Click <strong>Sign in</strong> for one-click auth, and hit <strong>Sync</strong>.</p>
                    </div>

                    <div className="bg-slate-900 border border-white/5 p-5 rounded-2xl relative overflow-hidden group">
                      <div className="absolute top-0 right-0 w-full h-full bg-purple-500/5 group-hover:bg-purple-500/10 transition-colors pointer-events-none"></div>
                      <h4 className="text-purple-400 font-semibold mb-2 flex items-center gap-2">
                        ADO Synchronization
                      </h4>
                      <p className="text-sm">Go to <code className="bg-black/50 px-1 rounded">Settings {`>`} ADO Integration</code>. Enter PAT to sync pull requests, tickets, and work items.</p>
                    </div>
                  </div>
                </div>
              </div>
              
            </div>
          </div>
        </section>

      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-12 bg-slate-950 relative">
        <div className="container mx-auto px-6 relative z-10">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex flex-shrink-0 items-center justify-center">
                 <Image src="/icon.png" width={20} height={20} alt="Logo" className="w-[20px] h-[20px] object-contain opacity-80" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">WorkspaceGPT</h2>
                <p className="text-slate-500 text-sm">Locally, privately, intelligently.</p>
              </div>
            </div>
            
            <div className="flex gap-8 text-sm font-medium">
              <a href="https://github.com/ritesh-kant/workspaceGPT/issues" className="text-slate-400 hover:text-white transition-colors">GitHub Issues</a>
              <a href="mailto:contact@workspacegpt.in" className="text-slate-400 hover:text-white transition-colors">Contact</a>
              <a href="https://devnotes.tech/tag/workspacegpt/" className="text-slate-400 hover:text-white transition-colors">Blog</a>
            </div>
          </div>
          <div className="mt-12 pt-8 border-t border-white/5 text-center flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-slate-600 text-sm">© {new Date().getFullYear()} WorkspaceGPT. Proprietary Software.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
