import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "../_components/Icon";
import { SiteNav } from "../_components/SiteNav";
import { SiteFooter } from "../_components/SiteFooter";
import { CHANGELOG, entryAnchor as anchor, formatDate, releaseLabel } from "./entries";

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "What's new in WorkspaceGPT: Confluence page editing, browser control, WorkspaceGPT Desktop for macOS and Windows, Chat and Work modes, and every release since.",
  alternates: {
    canonical: "/changelog",
  },
};

const RELEASES_URL = "https://github.com/ritesh-kant/workspaceGPT/releases";

function ReleaseChip({ label, latest }: { label: string; latest?: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border font-mono ${
        latest ? "bg-brand/10 text-brand border-brand/20" : "bg-white/[0.03] text-muted border-line"
      }`}
    >
      {label}
    </span>
  );
}

export default function ChangelogPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background text-muted">
      <SiteNav />

      <main className="flex-grow">
        <header className="border-b border-line">
          <div className="container mx-auto px-6 max-w-5xl py-16 sm:py-20">
            <p className="text-sm font-medium text-brand mb-4">Changelog</p>
            <h1 className="text-4xl sm:text-5xl font-normal tracking-tight text-foreground mb-5">What&apos;s new in WorkspaceGPT</h1>
            <p className="text-lg text-muted max-w-2xl leading-relaxed">
              New capabilities, fixes and releases for the editor extension, WorkspaceGPT Desktop and the Chrome
              extension, newest first.
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-6 text-sm">
              <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-muted hover:text-foreground transition-colors">
                Release downloads <Icon name="external-link" size={14} />
              </a>
              <Link href="/#install" className="inline-flex items-center gap-1.5 text-muted hover:text-foreground transition-colors">
                Install or update <Icon name="arrow-right" size={14} />
              </Link>
            </div>
          </div>
        </header>

        <div className="container mx-auto px-6 max-w-5xl">
          {CHANGELOG.map((entry, i) => (
            <article
              key={anchor(entry)}
              id={anchor(entry)}
              className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-6 md:gap-12 py-14 sm:py-16 border-b border-line last:border-b-0 scroll-mt-20"
            >
              <div>
                <div className="md:sticky md:top-24">
                  <a href={`#${anchor(entry)}`} className="text-sm text-foreground hover:text-brand transition-colors">
                    <time dateTime={entry.date}>{formatDate(entry.date)}</time>
                  </a>
                  <div className="flex flex-wrap md:flex-col md:items-start gap-2 mt-3">
                    {entry.releases.map((r) => (
                      <ReleaseChip key={releaseLabel(r)} label={releaseLabel(r)} latest={i === 0} />
                    ))}
                  </div>
                </div>
              </div>

              <div className="min-w-0">
                <h2 className="text-2xl sm:text-3xl font-normal tracking-tight text-foreground mb-3">{entry.title}</h2>
                <p className="text-muted leading-relaxed mb-8 max-w-2xl">{entry.summary}</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  {entry.items.map((item) => (
                    <div key={item.title} className="bg-surface border border-line rounded-xl p-5 hover:border-line-strong transition-colors">
                      <div className="flex items-center gap-3 mb-2">
                        <span className="text-brand">
                          <Icon name={item.icon} size={18} />
                        </span>
                        <h3 className="font-semibold text-white">{item.title}</h3>
                      </div>
                      <p className="text-sm leading-relaxed">{item.body}</p>
                    </div>
                  ))}
                </div>
              </div>
            </article>
          ))}

          <p className="text-sm text-faint py-12 border-t border-line">
            Older releases are listed on{" "}
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
              GitHub
            </a>
            .
          </p>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
