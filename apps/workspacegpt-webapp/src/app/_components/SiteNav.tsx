"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/#features", label: "Features" },
  { href: "/#see-it", label: "See it work" },
  { href: "/#modes", label: "Privacy" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
];

/**
 * The site had no navigation at all — one inline "How privacy works" link in
 * the hero. A bare page reads as a landing-page template rather than a product,
 * so this is a plain sticky bar: wordmark, a few destinations, source, install.
 * Every page uses it, so the page you're on is marked rather than repeated in
 * a breadcrumb.
 */
export function SiteNav({ onInstall }: { onInstall?: () => void }) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-background/80 backdrop-blur-md">
      <nav className="container mx-auto px-6 h-14 flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Image src="/icon.png" alt="" width={22} height={22} className="w-[22px] h-[22px] object-contain" />
          <span className="font-medium tracking-tight text-foreground">WorkspaceGPT</span>
        </Link>

        <div className="hidden md:flex items-center gap-7 text-sm">
          {LINKS.map((l) => {
            const current = !l.href.startsWith("/#") && pathname?.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={current ? "page" : undefined}
                className={current ? "text-foreground" : "text-muted hover:text-foreground transition-colors"}
              >
                {l.label}
              </Link>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <a
            href="https://github.com/ritesh-kant/workspaceGPT"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline text-sm text-muted hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          {onInstall ? (
            <button
              onClick={onInstall}
              className="text-sm font-medium bg-brand text-black px-3.5 py-1.5 rounded-lg hover:bg-[#3df5c2] transition-colors"
            >
              Install
            </button>
          ) : (
            <Link
              href="/#install"
              className="text-sm font-medium bg-brand text-black px-3.5 py-1.5 rounded-lg hover:bg-[#3df5c2] transition-colors"
            >
              Install
            </Link>
          )}
        </div>
      </nav>
    </header>
  );
}
