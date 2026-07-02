import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Documentation",
    template: "%s | WorkspaceGPT",
  },
  description:
    "Install WorkspaceGPT, pick an AI provider (Ollama, OpenAI, Gemini), and connect Confluence and Azure DevOps. Full setup and troubleshooting guide.",
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
