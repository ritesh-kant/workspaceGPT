import type { Metadata } from "next";
import { SiteNav } from "../_components/SiteNav";
import { SiteFooter } from "../_components/SiteFooter";

export const metadata: Metadata = {
  title: "Trust & Data Flow",
  description:
    "Exactly what WorkspaceGPT sends, to whom, and when, for every mode. Plus how to verify it yourself.",
  alternates: { canonical: "/trust" },
  openGraph: {
    type: "website",
    url: "/trust",
    siteName: "WorkspaceGPT",
    title: "WorkspaceGPT Trust & Data Flow",
    description: "What leaves your machine in each mode, and how to check it yourself.",
  },
};

const REPO = "https://github.com/ritesh-kant/workspaceGPT/blob/main";

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      {id && <div id={id} className="-mt-20 pt-20" />}
      <h2 className="text-xl font-semibold text-white mb-3">{title}</h2>
      <div className="space-y-3 text-muted leading-relaxed">{children}</div>
    </section>
  );
}

const MODES: { name: string; badge: string; goesTo: string; sees: string }[] = [
  {
    name: "Local model (Ollama, or a server on localhost)",
    badge: "Stays on device",
    goesTo: "Nowhere. The model runs on your machine.",
    sees: "Nobody.",
  },
  {
    name: "Your GitHub Copilot plan",
    badge: "→ GitHub Copilot",
    goesTo: "GitHub Copilot, under your GitHub account and terms.",
    sees: "GitHub, and the model provider Copilot routes to. Not WorkspaceGPT.",
  },
  {
    name: "Your own key (OpenAI, Gemini, Groq, OpenRouter, NVIDIA, custom endpoint)",
    badge: "→ that provider",
    goesTo: "Straight from your machine to that provider, under your account with them.",
    sees: "That provider. Not WorkspaceGPT.",
  },
  {
    name: "Remote mode (managed inference, Preview)",
    badge: "→ WorkspaceGPT",
    goesTo: "The WorkspaceGPT endpoint, then its upstream model provider (currently OpenRouter).",
    sees: "The endpoint and the upstream provider process it in memory. We store none of it.",
  },
];

export default function TrustPage() {
  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <SiteNav />
      <main className="flex-grow">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <h1 className="text-3xl sm:text-4xl font-normal tracking-tight text-white">Trust &amp; data flow</h1>
          <p className="mt-6 text-muted leading-relaxed">
            The question we hear most is whether WorkspaceGPT stores your organisation&rsquo;s data.
            It does not. This page says what is sent where, and shows how to confirm it without
            taking our word for it.
          </p>

          <div className="mt-8 rounded-xl border border-brand/20 bg-brand/5 p-6">
            <h2 className="text-lg font-semibold text-white mb-3">In short</h2>
            <ul className="list-disc pl-6 space-y-2 text-muted">
              <li>
                <strong className="text-white">Your Knowledge is indexed on your machine.</strong>{" "}
                Confluence, Jira and Azure DevOps content is synced, embedded and searched locally,
                and the index is stored in local files. Source code is read in place and not indexed.
              </li>
              <li>
                <strong className="text-white">Only the question and the snippets retrieved for it
                ever leave</strong>, and only to the model you chose. Your index, repository and
                Knowledge corpus are never uploaded.
              </li>
              <li>
                <strong className="text-white">You can keep us out of the path entirely.</strong> Use a
                local model, your Copilot plan, or your own key, and no request touches a
                WorkspaceGPT server.
              </li>
              <li>
                <strong className="text-white">The app tells you where the next question goes.</strong>{" "}
                A label beside the model picker shows it live.
              </li>
            </ul>
          </div>

          <Section id="data-flow" title="What is sent, by mode">
            <p>
              The mode and model you pick change one thing: where the answer is generated. They never
              change where your content is stored.
            </p>
            <div className="mt-4 space-y-3">
              {MODES.map((m) => (
                <div key={m.name} className="rounded-xl border border-line bg-surface p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="font-semibold text-white">{m.name}</h3>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border bg-brand/10 text-brand border-brand/20">
                      {m.badge}
                    </span>
                  </div>
                  <dl className="mt-3 text-sm space-y-1">
                    <div><dt className="inline text-white">Sent to: </dt><dd className="inline">{m.goesTo}</dd></div>
                    <div><dt className="inline text-white">Who can see it: </dt><dd className="inline">{m.sees}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
            <p className="text-sm">
              If your organisation already approves GitHub Copilot, using your Copilot plan adds no
              new vendor. Copilot&rsquo;s own retention depends on your GitHub plan, so check yours.
              On the desktop app the Copilot connection is a direct, unofficial path to Copilot&rsquo;s
              API; in VS Code it goes through VS Code&rsquo;s Language Model API.
            </p>
            <p className="text-sm">
              Only a local model gives a guarantee that nothing leaves your machine. Every other
              option sends the question and retrieved snippets to the provider you picked.
            </p>
          </Section>

          <Section id="never-leaves" title="What never leaves your machine">
            <ul className="list-disc pl-6 space-y-2">
              <li>The vector index and embeddings (computed on-device in every mode).</li>
              <li>Your repository, and your Confluence, Jira and Azure DevOps corpus.</li>
              <li>
                Credentials for those systems. They are kept in your IDE&rsquo;s secret storage, or the
                macOS Keychain / Windows Credential Manager on Desktop.
              </li>
              <li>
                Requests to Confluence, Jira and Azure DevOps go from your machine directly to those
                services. They do not pass through us.
              </li>
            </ul>
          </Section>

          <Section id="see-your-data" title="See and delete what is stored">
            <p>
              In <code className="text-brand">Settings → Knowledge</code>, each connected source shows how
              many items it has stored on your device and how much space they take. <em>Show folder</em>{" "}
              opens the folder in Finder or Explorer, so you can read the files yourself.{" "}
              <em>Delete local copy</em> removes them and keeps the connection; the next sync downloads
              them again. Disconnecting a source deletes them too.
            </p>
          </Section>

          <Section id="verify" title="Check it yourself">
            <p>You don&rsquo;t need to trust this page. Three ways to confirm it:</p>
            <ol className="list-decimal pl-6 space-y-3">
              <li>
                <strong className="text-white">Watch the network.</strong> Start a network monitor (Little
                Snitch or Lulu on macOS, Resource Monitor or Wireshark on Windows), then sync Confluence
                and ask a question with a local model. You will see traffic to your Atlassian or Azure
                DevOps host and to PostHog analytics, and nothing carrying your content anywhere else.
              </li>
              <li>
                <strong className="text-white">Read the code.</strong> The source is on GitHub. The files
                that matter:{" "}
                <a className="text-brand hover:underline" href={`${REPO}/apps/workspacegpt-api/src/chat.ts`}>
                  the Remote endpoint
                </a>{" "}
                (it logs a status code and error type only, never a request or response body), and{" "}
                <a className="text-brand hover:underline" href={`${REPO}/apps/vscode-extensions/src/services/analyticsService.ts`}>
                  the analytics service
                </a>
                .
              </li>
              <li>
                <strong className="text-white">Look at what each question carries.</strong> The question
                and the snippets sent with it are the whole payload. Point a local proxy at your
                provider&rsquo;s base URL (Custom provider) to read exactly what is sent.
              </li>
            </ol>
          </Section>

          <Section id="analytics" title="Analytics, in full">
            <p>
              The app sends anonymous usage events to PostHog (EU) in every mode. They carry an event
              name, an install identifier, versions, and the active mode, and never prompts, answers,
              file contents, paths or document titles. The{" "}
              <a className="text-brand hover:underline" href="/privacy#analytics">privacy policy</a> lists
              every field. There is no in-app switch for it yet; to turn it off, block{" "}
              <code className="text-brand">eu.i.posthog.com</code> or email us.
            </p>
          </Section>

          <Section id="remote" title="Remote mode, plainly">
            <p>
              Remote mode is the one path where your question and retrieved snippets pass through a
              server we run. The endpoint does not log request or response bodies and writes nothing
              about them to a database. What we store is your GitHub identity, plan, a session token and
              a weekly credit count. The upstream provider is OpenRouter, and it is the authority on
              its own handling. We do not opt our account into prompt logging or data sharing. If you
              need a guarantee across the whole path, use a local model.
            </p>
          </Section>

          <Section id="security" title="Security contact">
            <p>
              Found a problem, or need our answers for a security review? Write to{" "}
              <a className="text-brand hover:underline" href="mailto:contact@workspacegpt.in">contact@workspacegpt.in</a>
              . For a vulnerability, say so in the subject line and we will reply directly.
            </p>
          </Section>

          <p className="mt-12 text-sm text-faint">
            See the full <a className="text-brand hover:underline" href="/privacy">Privacy Policy</a>.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
