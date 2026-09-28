import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Documentation",
    template: "%s | WorkspaceGPT",
  },
  description:
    "Install WorkspaceGPT in your editor or as a desktop app (macOS, Windows), pick an AI provider or Remote mode, connect Confluence, Jira and Azure DevOps, let the agent edit Confluence pages and use your browser. Full setup and troubleshooting guide.",
  alternates: {
    canonical: "/docs",
  },
  openGraph: {
    title: "WorkspaceGPT Documentation",
    description:
      "Installation (editor and Desktop), AI providers, Chat and Work modes, Confluence page editing, Jira and Azure DevOps, browser control, MCP server, and troubleshooting.",
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
