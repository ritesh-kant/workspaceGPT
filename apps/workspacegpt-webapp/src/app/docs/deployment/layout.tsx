import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Deployment Automation Docs",
  description:
    "Automate release config-sync and hotfix workflows with WorkspaceGPT: sources, actions, environments, and security model.",
  alternates: {
    canonical: "/docs/deployment",
  },
  openGraph: {
    title: "WorkspaceGPT Deployment Automation",
    description:
      "Automate release config-sync and hotfix workflows: sources, actions, connections, environments, and security model.",
    url: "/docs/deployment",
  },
};

export default function DeploymentDocsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
