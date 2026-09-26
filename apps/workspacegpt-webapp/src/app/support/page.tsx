import type { Metadata } from "next";
import Link from "next/link";
import { SiteNav } from "../_components/SiteNav";
import { SiteFooter } from "../_components/SiteFooter";

export const metadata: Metadata = {
  title: "Support",
  description:
    "Get help with WorkspaceGPT — contact support, report an issue, or read the docs.",
  alternates: {
    canonical: "/support",
  },
};

const GITHUB_ISSUES = "https://github.com/ritesh-kant/workspaceGPT/issues";
const SUPPORT_EMAIL = "contact@workspacegpt.in";

function Card({
  title,
  children,
  href,
  cta,
}: {
  title: string;
  children: React.ReactNode;
  href: string;
  cta: string;
}) {
  const external = href.startsWith("http");
  return (
    <div className="rounded-xl border border-line bg-surface p-6">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <p className="mt-2 text-muted leading-relaxed">{children}</p>
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className="mt-4 inline-flex items-center text-sm font-medium text-brand hover:underline"
      >
        {cta} →
      </a>
    </div>
  );
}

export default function SupportPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
    <SiteNav />
    <main className="flex-grow">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl sm:text-4xl font-normal tracking-tight text-white">Support</h1>
        <p className="mt-3 text-muted leading-relaxed">
          Need help with WorkspaceGPT? Here&rsquo;s how to reach us. We typically respond
          within a couple of business days.
        </p>

        <div className="mt-8 grid gap-5">
          <Card
            title="Email us"
            href={`mailto:${SUPPORT_EMAIL}`}
            cta={`Email ${SUPPORT_EMAIL}`}
          >
            For account questions, setup help, or anything else, send us an email and
            we&rsquo;ll get back to you.
          </Card>

          <Card title="Report a bug or request a feature" href={GITHUB_ISSUES} cta="Open a GitHub issue">
            Found a bug or have an idea? Open an issue on GitHub. Include your editor (or
            WorkspaceGPT Desktop) and extension versions, and steps to reproduce, so we can help faster.
          </Card>

          <Card title="See what changed" href="/changelog" cta="Read the changelog">
            New features and fixes in each release of the extension, WorkspaceGPT Desktop and the
            Chrome extension &mdash; handy for checking whether an update already fixes your issue.
          </Card>

          <Card title="Read the docs" href="/docs" cta="Browse documentation">
            Setup guides for the extension and the desktop app, AI provider configuration,
            connecting Confluence, Jira and Azure DevOps, browser control, and troubleshooting tips.
          </Card>
        </div>

        <p className="mt-10 text-sm text-faint">
          You can also review our{" "}
          <Link href="/privacy" className="text-brand hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </main>
    <SiteFooter />
    </div>
  );
}
