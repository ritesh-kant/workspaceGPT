import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Documentation",
    template: "%s | WorkspaceGPT",
  },
  description:
    "Complete guide to WorkspaceGPT: installation, AI providers (Ollama, OpenAI, Gemini, Groq, OpenRouter), codebase indexing, Confluence and Azure DevOps integration, MCP server, Chrome extension, and troubleshooting.",
  alternates: {
    canonical: "/docs",
  },
  openGraph: {
    title: "WorkspaceGPT Documentation",
    description:
      "Installation, AI providers, codebase indexing, Confluence and Azure DevOps integration, MCP server, and troubleshooting.",
    url: "/docs",
  },
};

export default function DocsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
