import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Analytics } from '@vercel/analytics/react';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://www.workspacegpt.in";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "WorkspaceGPT — Local, Private AI Coding Assistant",
    template: "%s | WorkspaceGPT",
  },
  description:
    "A RAG-based AI coding assistant with zero data retention. Your documents, code, and search index never leave your machine — in Local mode (your own model) or Remote mode (we run the model). For VS Code, Cursor, and Antigravity.",
  applicationName: "WorkspaceGPT",
  keywords: [
    "AI coding assistant",
    "local AI assistant",
    "private AI code chat",
    "RAG codebase chat",
    "VS Code extension",
    "Cursor extension",
    "Ollama coding assistant",
    "Confluence AI integration",
    "Azure DevOps AI integration",
    "chat with codebase",
    "zero data retention AI",
    "on-device embeddings",
    "no data retention coding assistant",
    "GDPR-friendly AI assistant",
  ],
  authors: [{ name: "Ritesh Kant", url: "https://github.com/ritesh-kant" }],
  creator: "Ritesh Kant",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "WorkspaceGPT",
    title: "WorkspaceGPT — Local, Private AI Coding Assistant",
    description:
      "Chat with your codebase, Confluence docs, and Azure DevOps inside your IDE. Zero data retention — your content and search index stay on your machine.",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "WorkspaceGPT — Local, Private AI Coding Assistant",
    description:
      "Chat with your codebase, Confluence docs, and Azure DevOps inside your IDE. Zero data retention — your content and search index stay on your machine.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/icon.png",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#software`,
      name: "WorkspaceGPT",
      description:
        "A RAG-based AI coding assistant with zero data retention. Indexing and the vector store run on-device in both Local and Remote mode. Chat with your codebase, Confluence docs, and Azure DevOps work items inside VS Code, Cursor, or Antigravity.",
      url: SITE_URL,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Windows, macOS, Linux",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
      },
      softwareRequirements: "VS Code, Cursor, or Antigravity IDE",
      author: {
        "@type": "Person",
        name: "Ritesh Kant",
        url: "https://github.com/ritesh-kant",
      },
      downloadUrl:
        "https://marketplace.visualstudio.com/items?itemName=Riteshkant.workspacegpt-extension",
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "WorkspaceGPT",
      publisher: { "@id": `${SITE_URL}/#software` },
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <Analytics/>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-[#030712] text-slate-100 min-h-screen selection:bg-[#1ff2b4] selection:text-black`}
      >
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {children}
      </body>
    </html>
  );
}
