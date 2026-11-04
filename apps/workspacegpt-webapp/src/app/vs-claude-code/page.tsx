import type { Metadata } from "next";
import { SiteNav } from "../_components/SiteNav";
import { SiteFooter } from "../_components/SiteFooter";

export const metadata: Metadata = {
  title: "WorkspaceGPT vs Claude Code",
  description:
    "Claude Code can read Confluence through an MCP server. Here is what WorkspaceGPT does differently with your organisation's Knowledge, and how to use both.",
  alternates: { canonical: "/vs-claude-code" },
  openGraph: {
    type: "website",
    url: "/vs-claude-code",
    siteName: "WorkspaceGPT",
    title: "WorkspaceGPT vs Claude Code",
    description: "A coding agent with a connection to your Knowledge, or one whose memory is your Knowledge.",
  },
};

// Keep every row checked against the current product and the current
// Atlassian / Azure DevOps MCP servers before this page is linked anywhere.
const ROWS: { topic: string; other: string; ours: string }[] = [
  {
    topic: "How Knowledge is read",
    other: "Live fetch. One search call per question, through the source's own search.",
    ours: "Synced to your machine and indexed with embeddings, so search is semantic across all of it.",
  },
  {
    topic: "If the wrong keyword is picked",
    other: "The right page may never be seen.",
    ours: "Retrieval does not hinge on guessing the page's wording.",
  },
  {
    topic: "Where indexing happens",
    other: "Nothing is indexed. Every page the agent opens is sent to the model provider.",
    ours: "Indexing and embeddings stay on your device. Only the question and the snippets retrieved for it go to the model.",
  },
  {
    topic: "Starting from a ticket",
    other: "You write the process in a prompt or a project file.",
    ours: "Built in: read the ticket, research every source, write the spike, ask what it needs from you, list references, publish to Confluence after review.",
  },
  {
    topic: "Where a claim came from",
    other: "No record of which page backed which statement.",
    ours: "References link to what the run actually read, and reports list their sources.",
  },
  {
    topic: "Deleted or moved pages",
    other: "No local copy, so nothing to go stale, and nothing to reason over.",
    ours: "Sync removes pages that were deleted, moved or renamed upstream, so they are not cited.",
  },
  {
    topic: "Which model",
    other: "Anthropic models.",
    ours: "Your Copilot plan, your own key (OpenAI, Gemini, OpenRouter and others), a local model, or managed inference.",
  },
  {
    topic: "Setup",
    other: "Configure each server, its tokens and your project instructions.",
    ours: "Connect each Knowledge source once.",
  },
];

export default function VsClaudeCodePage() {
  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      <SiteNav />
      <main className="flex-grow">
        <div className="max-w-3xl mx-auto px-6 py-16">
          <h1 className="text-3xl sm:text-4xl font-normal tracking-tight text-white">
            WorkspaceGPT vs Claude Code
          </h1>
          <p className="mt-6 text-muted leading-relaxed">
            Claude Code is a strong general coding agent, and with an Atlassian or Azure DevOps MCP
            server it can look things up in your organisation. That is real, and we won&rsquo;t pretend
            otherwise. The difference is what happens once it can reach the pages.
          </p>

          <div className="mt-8 rounded-xl border border-brand/20 bg-brand/5 p-6">
            <h2 className="text-lg font-semibold text-white mb-3">In short</h2>
            <p className="text-muted">
              Claude Code is a general agent with connectors. WorkspaceGPT is an agent whose memory is
              your organisation&rsquo;s Knowledge: Confluence, Jira and Azure DevOps, indexed on your
              machine and used to ground every answer.
            </p>
          </div>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white mb-3">Side by side</h2>
            <div className="overflow-x-auto rounded-xl border border-line bg-surface">
              <table className="w-full min-w-[640px] text-sm text-left border-collapse">
                <thead>
                  <tr className="border-b border-line text-white">
                    <th scope="col" className="p-4 font-semibold w-1/5">&nbsp;</th>
                    <th scope="col" className="p-4 font-semibold w-2/5">Claude Code with MCP</th>
                    <th scope="col" className="p-4 font-semibold w-2/5 text-brand">WorkspaceGPT</th>
                  </tr>
                </thead>
                <tbody className="text-muted align-top">
                  {ROWS.map((r) => (
                    <tr key={r.topic} className="border-b border-line last:border-b-0">
                      <th scope="row" className="p-4 font-semibold text-white">{r.topic}</th>
                      <td className="p-4">{r.other}</td>
                      <td className="p-4">{r.ours}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm text-muted">
              Comparison reflects Claude Code with the standard Atlassian and Azure DevOps MCP servers
              at the time of writing. Both products change; check the current docs for each.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white mb-3">Why the index matters</h2>
            <div className="space-y-3 text-muted leading-relaxed">
              <p>
                Most of what a ticket needs is in pages nobody would think to search for by name: an
                old decision, a runbook, a spike from another team. A search box finds them only if you
                guess their words. An index built from everything you have synced finds them by
                meaning, before you ask.
              </p>
              <p>
                It also changes what leaves your machine. Because the index is local, a question sends
                only itself and the few snippets retrieved for it. See{" "}
                <a className="text-brand hover:underline" href="/trust">Trust &amp; data flow</a> for
                exactly what is sent in each mode.
              </p>
            </div>
          </section>

          <section className="mt-12">
            <h2 className="text-xl font-semibold text-white mb-3">Use both</h2>
            <p className="text-muted leading-relaxed">
              WorkspaceGPT ships an MCP server, so Claude Code, or any MCP client, can search the same
              Knowledge. If your team already lives in Claude Code, you can keep it and add your
              organisation&rsquo;s memory to it.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
