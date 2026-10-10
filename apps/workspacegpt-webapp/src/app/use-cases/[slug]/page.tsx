import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SiteNav } from "../../_components/SiteNav";
import { SiteFooter } from "../../_components/SiteFooter";
import { USE_CASES, USE_CASE_BY_SLUG } from "../content";

const SITE_URL = "https://www.workspacegpt.in";

type Params = { slug: string };

export function generateStaticParams() {
  return USE_CASES.map((u) => ({ slug: u.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const u = USE_CASE_BY_SLUG.get((await params).slug);
  if (!u) return {};
  const path = `/use-cases/${u.slug}`;
  return {
    title: u.title,
    description: u.description,
    alternates: { canonical: path },
    openGraph: {
      type: "article",
      url: path,
      siteName: "WorkspaceGPT",
      title: u.title,
      description: u.description,
    },
    twitter: { card: "summary_large_image", title: u.title, description: u.description },
  };
}

export default async function UseCasePage({ params }: { params: Promise<Params> }) {
  const u = USE_CASE_BY_SLUG.get((await params).slug);
  if (!u) notFound();

  const url = `${SITE_URL}/use-cases/${u.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#page`,
        url,
        name: u.title,
        description: u.description,
        dateModified: u.updated,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        about: { "@id": `${SITE_URL}/#software` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "WorkspaceGPT", item: SITE_URL },
          { "@type": "ListItem", position: 2, name: u.h1, item: url },
        ],
      },
      {
        "@type": "FAQPage",
        mainEntity: u.faq.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  const others = USE_CASES.filter((o) => o.slug !== u.slug);

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <SiteNav />
      <main className="flex-grow">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <div className="max-w-3xl mx-auto px-6 py-16">
          <h1 className="text-3xl sm:text-5xl font-normal tracking-tight text-white leading-[1.1]">{u.h1}</h1>
          <p className="mt-6 text-lg text-muted leading-relaxed">{u.lede}</p>

          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/#install"
              className="bg-brand hover:bg-[#3df5c2] text-black font-medium px-6 py-3 rounded-lg transition-colors"
            >
              Install WorkspaceGPT
            </Link>
            <Link
              href="/docs"
              className="bg-surface hover:bg-surface-2 border border-line hover:border-line-strong text-foreground font-medium px-6 py-3 rounded-lg transition-colors"
            >
              Read the docs
            </Link>
          </div>

          <section className="mt-16">
            <h2 className="text-2xl font-medium tracking-tight text-white">{u.problem.heading}</h2>
            {u.problem.body.map((p) => (
              <p key={p} className="mt-4 text-muted leading-relaxed">
                {p}
              </p>
            ))}
          </section>

          <section className="mt-16">
            <h2 className="text-2xl font-medium tracking-tight text-white">How it works</h2>
            <ol className="mt-6 grid gap-4">
              {u.steps.map((s, i) => (
                <li key={s.title} className="rounded-xl border border-line bg-surface p-6">
                  <h3 className="text-lg font-semibold text-white">
                    {i + 1}. {s.title}
                  </h3>
                  <p className="mt-2 text-muted leading-relaxed">{s.body}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="mt-16">
            <h2 className="text-2xl font-medium tracking-tight text-white">What you get</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {u.points.map((p) => (
                <div key={p.title} className="rounded-xl border border-line bg-surface p-6">
                  <h3 className="font-semibold text-white">{p.title}</h3>
                  <p className="mt-2 text-sm text-muted leading-relaxed">{p.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-16">
            <h2 className="text-2xl font-medium tracking-tight text-white">Frequently asked questions</h2>
            <dl className="mt-6 grid gap-6">
              {u.faq.map((f) => (
                <div key={f.q}>
                  <dt className="font-semibold text-white">{f.q}</dt>
                  <dd className="mt-2 text-muted leading-relaxed">{f.a}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="mt-16 border-t border-line pt-8">
            <h2 className="text-sm font-semibold text-white">More ways to use WorkspaceGPT</h2>
            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {others.map((o) => (
                <li key={o.slug}>
                  <Link href={`/use-cases/${o.slug}`} className="text-brand hover:underline">
                    {o.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/" className="text-brand hover:underline">
                  WorkspaceGPT overview
                </Link>
              </li>
            </ul>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
