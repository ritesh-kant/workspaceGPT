import Image from "next/image";
import Link from "next/link";

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
  { href: "/privacy", label: "Privacy" },
  { href: "/support", label: "Support" },
  { href: "https://github.com/ritesh-kant/workspaceGPT/issues", label: "GitHub Issues" },
  { href: "https://devnotes.tech/tag/workspacegpt/", label: "Blog" },
];

/** One footer for every page, so the docs and legal pages don't each grow their own. */
export function SiteFooter() {
  return (
    <footer className="border-t border-line py-8 sm:py-12 bg-background relative">
      <div className="container mx-auto px-6 relative z-10">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-white/5 border border-line flex flex-shrink-0 items-center justify-center">
              <Image src="/icon.png" width={20} height={20} alt="Logo" className="w-[20px] h-[20px] object-contain opacity-80" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">WorkspaceGPT</h2>
              <p className="text-faint text-sm">Your data stays yours. Zero retention.</p>
            </div>
          </div>

          <div className="flex flex-wrap justify-center gap-x-8 gap-y-3 text-sm font-medium">
            {LINKS.map((l) =>
              l.href.startsWith("http") ? (
                <a key={l.href} href={l.href} className="text-muted hover:text-white transition-colors">
                  {l.label}
                </a>
              ) : (
                <Link key={l.href} href={l.href} className="text-muted hover:text-white transition-colors">
                  {l.label}
                </Link>
              )
            )}
            <a href="mailto:contact@workspacegpt.in" className="text-muted hover:text-white transition-colors">Contact</a>
          </div>
        </div>
        <div className="mt-12 pt-8 border-t border-line text-center flex flex-col md:flex-row justify-between items-center gap-4">
          <p className="text-faint text-sm">© {new Date().getFullYear()} WorkspaceGPT. Proprietary Software.</p>
        </div>
      </div>
    </footer>
  );
}
