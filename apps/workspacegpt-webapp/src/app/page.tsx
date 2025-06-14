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

  const openInstallModal = () => {
    setShowInstallModal(true);
  };

  const closeInstallModal = () => {
    setShowInstallModal(false);
  };

  const openVSCode = () => {
    // Try to open VS Code with your extension in the marketplace
    window.open('vscode:extension/Riteshkant.workspacegpt-extension');

    // Show a message to the user that we attempted to open VS Code
    setShowVSCodeOpenedMessage(true);
    setShowFallbackLink(true);
    setShowInstallModal(false);

    // Hide the message after 5 seconds
    setTimeout(() => {
      setShowVSCodeOpenedMessage(false);
    }, 5000);
  };

  const openCursor = () => {
    // Try to open Cursor (assuming similar protocol)
    window.open('cursor:extension/Riteshkant.workspacegpt-extension');

    // Show a message to the user that we attempted to open Cursor
    setShowCursorOpenedMessage(true);
    setShowCursorFallbackLink(true);
    setShowInstallModal(false);

    // Hide the message after 5 seconds
    setTimeout(() => {
      setShowCursorOpenedMessage(false);
    }, 5000);
  };

  return (
    <div className="flex flex-col min-h-screen">
      {/* Install Modal */}
      {showInstallModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white bg-opacity-95 rounded-xl shadow-xl p-8 max-w-md w-full mx-4">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-purple-900">Install WorkspaceGPT</h2>
              <button 
                onClick={closeInstallModal}
                className="text-gray-500 hover:text-gray-700"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-center mb-6 text-gray-600">Select your IDE</p>
            
            <div className="space-y-4">
              {/* VS Code */}
              <div className="flex items-center justify-between bg-white rounded-lg p-4 shadow-sm border border-gray-100">
                <div className="flex items-center">
                  <div className="w-10 h-10 flex-shrink-0 mr-4">
                    <Image
                      src="/vscode-icon.svg"
                      alt="VS Code"
                      width={40}
                      height={40}
                    />
                  </div>
                  <span className="font-medium">VS Code</span>
                </div>
                <button
                  onClick={openVSCode}
                  className="bg-purple-600 hover:bg-purple-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  Install
                </button>
              </div>
              
              {/* Cursor */}
              <div className="flex items-center justify-between bg-white rounded-lg p-4 shadow-sm border border-gray-100">
                <div className="flex items-center">
                  <div className="w-10 h-10 flex-shrink-0 mr-4">
                    <Image
                      src="/cursor-icon.png"
                      alt="Cursor"
                      width={40}
                      height={40}
                    />
                  </div>
                  <span className="font-medium">Cursor</span>
                </div>
                <button
                  onClick={openCursor}
                  className="bg-purple-600 hover:bg-purple-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
                >
                  Install
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Hero Section */}
      <header className="bg-gradient-to-r from-blue-600 to-[#1ff2b4] text-white py-20 relative">
        {showVSCodeOpenedMessage && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-green-600 text-white px-6 py-3 rounded-lg shadow-lg transition-opacity duration-300 z-10">
            <p>Attempting to open WorkspaceGPT extension in VS Code. If it doesn&apos;t open, please make sure VS Code is installed.</p>
            {showFallbackLink && (
              <p className="mt-2">
                <a
                  href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium hover:text-white/80"
                >
                  Or click here to open in browser
                </a>
              </p>
            )}
          </div>
        )}
        {showCursorOpenedMessage && (
          <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-green-600 text-white px-6 py-3 rounded-lg shadow-lg transition-opacity duration-300 z-10">
            <p>Attempting to open WorkspaceGPT extension in Cursor. If it doesn&apos;t open, please make sure Cursor is installed.</p>
            {showCursorFallbackLink && (
              <p className="mt-2">
                <a
                  href="https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline font-medium hover:text-white/80"
                >
                  Or click here to open in browser
                </a>
              </p>
            )}
          </div>
        )}
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row items-center justify-between">
            <div className="md:w-1/2 mb-10 md:mb-0">
              <h1 className="text-4xl md:text-5xl font-bold mb-6">WorkspaceGPT</h1>
              <p className="text-xl mb-8">
                Your AI-powered, RAG-based coding assistant designed specifically for your local development environment.
              </p>
              <div className="flex flex-wrap gap-4">
                <Link
                  href="#features"
                  className="bg-white text-[#000000] hover:bg-gray-100 font-medium py-3 px-6 rounded-lg transition-colors flex items-center justify-center h-[50px]"
                >
                  Explore Features
                </Link>
                <button
                  onClick={openInstallModal}
                  className="bg-purple-600 hover:bg-purple-700 text-white font-medium px-6 rounded-full transition-colors flex items-center justify-center gap-2 h-[50px]"
                >
                  <div className="flex items-center">
                    <Image
                      src="/vscode-icon.svg"
                      alt="VS Code"
                      width={24}
                      height={24}
                      className="inline-block"
                    />
                    <Image
                      src="/cursor-icon.png"
                      alt="Cursor"
                      width={24}
                      height={24}
                      className="inline-block"
                    />
                    <span className="text-white mx-1">+</span>
                  </div>
                  <span>Install WorkspaceGPT</span>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="md:w-1/2 flex justify-center">
              <div className="relative w-full max-w-md">
                <Image
                  src="/icon.png"
                  alt="WorkspaceGPT Interface"
                  width={500}
                  height={400}
                  className="rounded-lg"
                  priority
                />
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-grow">
        {/* Privacy Section */}
        <section className="py-16 bg-gray-50">
          <div className="container mx-auto px-6">
            <h2 className="text-3xl font-bold text-center mb-12">🔐 100% Local & Private</h2>
            <div className="max-w-3xl mx-auto text-lg">
              <p className="mb-6">
                Everything in WorkspaceGPT runs <strong>locally</strong> on your system. No data is sent to third-party servers.
                Your code and your documents remain <strong>fully private and secure</strong>.
              </p>
              <p>
                You don&apos;t need to worry about confidentiality — we don&apos;t share or transmit anything outside your machine.
              </p>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="py-16">
          <div className="container mx-auto px-6">
            <h2 className="text-3xl font-bold text-center mb-12 text-gray-100">🧠 Features</h2>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              <div className="bg-white p-8 rounded-lg shadow-md">
                <div className="text-3xl mb-4">🤖</div>
                <h3 className="text-xl font-semibold mb-3">AI-Powered Workspace Q&A</h3>
                <p>Get context-aware answers from your local workspace using Retrieval-Augmented Generation (RAG).</p>
              </div>
              <div className="bg-white p-8 rounded-lg shadow-md">
                <div className="text-3xl mb-4">📄</div>
                <h3 className="text-xl font-semibold mb-3">Confluence Integration</h3>
                <p>Seamlessly connect to your Confluence space and chat with your documentation.</p>
              </div>
              <div className="bg-white p-8 rounded-lg shadow-md">
                <div className="text-3xl mb-4">🧭</div>
                <h3 className="text-xl font-semibold mb-3">Smart Code Navigation</h3>
                <p>Understand and explore your codebase more efficiently (coming soon!).</p>
              </div>
              <div className="bg-white p-8 rounded-lg shadow-md">
                <div className="text-3xl mb-4">💬</div>
                <h3 className="text-xl font-semibold mb-3">Interactive Chat Interface</h3>
                <p>Ask questions and receive intelligent, project-specific responses.</p>
              </div>
              <div className="bg-white p-8 rounded-lg shadow-md">
                <div className="text-3xl mb-4">⚡</div>
                <h3 className="text-xl font-semibold mb-3">Runs Locally</h3>
                <p>No remote APIs. Zero data leakage. Total privacy.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Getting Started Section */}
        <section id="getting-started" className="py-16 bg-gray-50">
          <div className="container mx-auto px-6">
            <h2 className="text-3xl font-bold text-center mb-12">🚀 Getting Started</h2>

            <div className="max-w-3xl mx-auto">
              <h3 className="text-xl font-semibold mb-4">Prerequisites</h3>
              <ul className="list-disc pl-6 mb-8 space-y-2">
                <li><a href="https://ollama.com" className="text-blue-600 hover:underline">Ollama</a> installed and running locally</li>
                <li>Node.js (v18 or higher)</li>
              </ul>

              <h3 className="text-xl font-semibold mb-4">Default Model</h3>
              <p className="mb-8">
                By default, WorkspaceGPT uses a lightweight model: <code className="bg-gray-200 px-2 py-1 rounded">llama3.2:1b</code>.
                If you&apos;re looking for more accurate and context-rich responses, you can switch to a more capable model
                that fits your system — such as <code className="bg-gray-200 px-2 py-1 rounded">llama3.2:4b</code>,
                <code className="bg-gray-200 px-2 py-1 rounded">gemma3:4b</code>, or <code className="bg-gray-200 px-2 py-1 rounded">mistral</code>.
              </p>

              <h3 className="text-xl font-semibold mb-4">Installation</h3>
              <ol className="list-decimal pl-6 mb-8 space-y-2">
                <li>Open Visual Studio Code</li>
                <li>Navigate to the Extensions view (<code className="bg-gray-200 px-2 py-1 rounded">Ctrl+Shift+X</code> or <code className="bg-gray-200 px-2 py-1 rounded">Cmd+Shift+X</code> on macOS)</li>
                <li>Search for <strong>&quot;WorkspaceGPT&quot;</strong></li>
                <li>Click <strong>Install</strong></li>
              </ol>
            </div>
          </div>
        </section>

        {/* Setup Guide Section */}
        <section className="py-16 text-gray-100">
          <div className="container mx-auto px-6">
            <h2 className="text-3xl font-bold text-center mb-12">🛠 Setup Guide</h2>

            <div className="max-w-3xl mx-auto">
              <ol className="list-decimal pl-6 mb-8 space-y-3">
                <li>Make sure Ollama is running on your system</li>
                <li>Open the <strong>WorkspaceGPT</strong> sidebar in VSCode</li>
                <li>Go to <code className="bg-gray-200 px-2 py-1 rounded text-black">Settings {`>`} Confluence Integration</code></li>
                <li>Enter your Confluence details</li>
                <li>Click <strong>&quot;Check Connection&quot;</strong> to verify access and fetch the total number of pages</li>
                <li>Click <strong>&quot;Start Sync&quot;</strong> to begin syncing your Confluence content (this may take time depending on the number of pages)</li>
              </ol>

              <div className="bg-blue-50 border-l-4 border-blue-500 p-4 mb-8 text-black">
                <h3 className="text-lg font-semibold mb-2">🔁 Reset WorkspaceGPT</h3>
                <p>
                  If you ever need to reset WorkspaceGPT to its default state, simply go to:
                  <br />
                  <code className="bg-gray-200 px-2 py-1 rounded mt-2 inline-block">Settings {`>`}  Reset VSCode State</code>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Contributing Section */}
        <section className="py-16 bg-gray-50">
          <div className="container mx-auto px-6">
            <h2 className="text-3xl font-bold text-center mb-12">🤝 Contributing</h2>

            <div className="max-w-3xl mx-auto">
              <p className="mb-6">We welcome contributions! Here&apos;s how:</p>
              <ol className="list-decimal pl-6 space-y-2">
                <li>Fork the repo</li>
                <li>Create your feature branch (<code className="bg-gray-200 px-2 py-1 rounded">git checkout -b feature/amazing-feature</code>)</li>
                <li>Commit your changes (<code className="bg-gray-200 px-2 py-1 rounded">git commit -m &apos;Add some amazing feature&apos;</code>)</li>
                <li>Push to your branch (<code className="bg-gray-200 px-2 py-1 rounded">git push origin feature/amazing-feature</code>)</li>
                <li>Open a Pull Request</li>
              </ol>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-gray-800 text-white py-12">
        <div className="container mx-auto px-6">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="mb-6 md:mb-0">
              <h2 className="text-2xl font-bold">WorkspaceGPT</h2>
              <p className="mt-2">Talk to your code and your Confluence docs. Locally, privately, and intelligently.</p>
            </div>
            <div className="flex flex-col md:flex-row gap-12">
              <div>
                <h3 className="text-lg font-semibold mb-3">Support</h3>
                <ul className="space-y-2">
                  <li><a href="#" className="hover:underline">Documentation</a></li>
                  <li><a href="https://github.com/ritesh-kant/workspaceGPT/issues" className="hover:underline">GitHub Issues</a></li>
                  <li><a href="mailto:contact@workspacegpt.in" className="hover:underline">Email Support</a></li>
                </ul>
              </div>
              <div>
                <h3 className="text-lg font-semibold mb-3">Resources</h3>
                <ul className="space-y-2">
                  <li><a href="https://devnotes.tech/tag/workspacegpt/" target="_blank" rel="noopener noreferrer" className="hover:underline">Blog</a></li>
                </ul>
              </div>
            </div>
          </div>
          <div className="mt-8 pt-8 border-t border-gray-700 text-center">
            <p>© {new Date().getFullYear()} WorkspaceGPT. Licensed under MIT.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
