import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Documentation",
    template: "%s | WorkspaceGPT",
  },
  description:
    "Install WorkspaceGPT in your editor or as a desktop app (macOS, Windows), pick an AI provider or Remote mode, and connect Confluence, Jira and Azure DevOps. Full setup and troubleshooting guide.",
  alternates: {
    canonical: "/docs",
  },
  openGraph: {
    title: "WorkspaceGPT Documentation",
    description:
      "Installation (editor and Desktop), AI providers, live codebase exploration, Confluence, Jira and Azure DevOps, MCP server, and troubleshooting.",
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
