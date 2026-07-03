"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";

const sections = [
  { id: "overview", label: "Overview & concepts" },
  { id: "quickstart", label: "Quickstart" },
  { id: "sources", label: "Sources" },
  { id: "actions", label: "Actions" },
  { id: "connections", label: "Connections & permissions" },
  { id: "releases", label: "The Releases workflow" },
  { id: "hotfix", label: "Hotfix flow" },
  { id: "environments", label: "Environments & policy" },
  { id: "ai", label: "AI-assisted reading" },
  { id: "security", label: "Security model" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "faq", label: "FAQ" },
];

function SectionAnchor({ id }: { id: string }) {
  return <div id={id} className="-mt-20 pt-20" />;
}

function Badge({ children, color = "brand" }: { children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    brand: "bg-brand/10 text-brand border-brand/20",
    blue: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    purple: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    yellow: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    red: "bg-red-500/10 text-red-400 border-red-500/20",
    green: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[color] ?? colors.brand}`}>
      {children}
    </span>
  );
}

function CodeBlock({ children, language = "bash" }: { children: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="relative group rounded-xl bg-slate-950 border border-white/10 overflow-hidden my-4">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/5 bg-white/2">
        <span className="text-xs text-slate-500 font-mono">{language}</span>
        <button onClick={copy} className="text-xs text-slate-500 hover:text-white transition-colors">
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre className="px-4 py-4 overflow-x-auto text-sm text-brand-blue font-mono leading-relaxed whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-5">
      <div className="flex-shrink-0 flex items-start pt-0.5">
        <div className="w-8 h-8 rounded-full bg-brand/20 border border-brand/30 text-brand font-bold text-sm flex items-center justify-center">
          {number}
        </div>
      </div>
      <div className="flex-1 pb-8">
        <h4 className="text-white font-semibold text-base mb-2">{title}</h4>
        <div className="text-slate-300 text-sm leading-relaxed space-y-2">{children}</div>
      </div>
    </div>
  );
}

function Card({ title, icon, children, accent = "brand" }: { title: string; icon: string; children: React.ReactNode; accent?: string }) {
  const accents: Record<string, string> = {
    brand: "hover:border-brand/40",
    blue: "hover:border-blue-500/40",
    purple: "hover:border-purple-500/40",
    green: "hover:border-emerald-500/40",
  };
  return (
    <div className={`bg-slate-900 border border-white/5 rounded-2xl p-6 ${accents[accent] ?? accents.brand} transition-colors duration-300`}>
      <div className="flex items-center gap-3 mb-3">
        <span className="text-xl">{icon}</span>
        <h4 className="text-white font-semibold">{title}</h4>
      </div>
      <div className="text-slate-300 text-sm leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-2xl sm:text-3xl font-bold text-white mb-2 tracking-tight">{children}</h2>;
}

function SectionSubtitle({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-400 mb-8 text-base">{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="text-lg font-semibold text-white mt-8 mb-4">{children}</h3>;
}

function H4({ children }: { children: React.ReactNode }) {
  return <h4 className="text-base font-semibold text-white mt-6 mb-3">{children}</h4>;
}

function Note({ children, color = "brand" }: { children: React.ReactNode; color?: string }) {
  const border: Record<string, string> = {
    brand: "border-brand/20",
    yellow: "border-yellow-500/20",
    red: "border-red-500/20",
    green: "border-emerald-500/20",
    blue: "border-blue-500/20",
  };
  return (
    <div className={`mt-2 p-5 bg-slate-900 border ${border[color] ?? border.brand} rounded-2xl text-sm text-slate-300`}>
      {children}
    </div>
  );
}

function PipelineDiagram() {
  return (
    <div className="my-6 rounded-2xl border border-white/10 bg-slate-950 p-4 overflow-x-auto">
      <svg viewBox="0 0 760 240" className="w-full min-w-[680px]" role="img" aria-label="A deployment pipeline: a Source feeds Stages of Actions, then a review and apply step.">
        {/* Source */}
        <rect x="10" y="60" width="150" height="120" rx="12" fill="#60a5fa14" stroke="#60a5fa55" />
        <text x="85" y="88" textAnchor="middle" fill="#93c5fd" fontSize="13" fontWeight="600">Source</text>
        <text x="85" y="112" textAnchor="middle" fill="#cbd5e1" fontSize="11">Confluence roster</text>
        <text x="85" y="132" textAnchor="middle" fill="#cbd5e1" fontSize="11">JSON file in repo</text>
        <text x="85" y="152" textAnchor="middle" fill="#cbd5e1" fontSize="11">Manual / none</text>

        {/* arrow */}
        <line x1="166" y1="120" x2="206" y2="120" stroke="#475569" strokeWidth="2" />
        <polygon points="206,120 198,116 198,124" fill="#475569" />

        {/* Stages */}
        <rect x="212" y="30" width="300" height="180" rx="12" fill="#a78bfa10" stroke="#a78bfa44" />
        <text x="362" y="52" textAnchor="middle" fill="#c4b5fd" fontSize="13" fontWeight="600">Stages → Actions</text>

        <rect x="230" y="68" width="264" height="56" rx="8" fill="#0f172a" stroke="#334155" />
        <text x="246" y="90" fill="#e2e8f0" fontSize="11" fontWeight="600">Frontend</text>
        <text x="246" y="108" fill="#94a3b8" fontSize="10.5">action: Vercel — env config</text>

        <rect x="230" y="134" width="264" height="56" rx="8" fill="#0f172a" stroke="#334155" />
        <text x="246" y="156" fill="#e2e8f0" fontSize="11" fontWeight="600">Backend</text>
        <text x="246" y="174" fill="#94a3b8" fontSize="10.5">action: GitHub — workflow dispatch</text>

        {/* arrow */}
        <line x1="518" y1="120" x2="558" y2="120" stroke="#475569" strokeWidth="2" />
        <polygon points="558,120 550,116 550,124" fill="#475569" />

        {/* Review & apply */}
        <rect x="564" y="60" width="186" height="120" rx="12" fill="#1ce2a712" stroke="#1ce2a755" />
        <text x="657" y="88" textAnchor="middle" fill="#5eead4" fontSize="13" fontWeight="600">Review &amp; apply</text>
        <text x="657" y="112" textAnchor="middle" fill="#cbd5e1" fontSize="11">Plan (diff)</text>
        <text x="657" y="132" textAnchor="middle" fill="#cbd5e1" fontSize="11">Approve</text>
        <text x="657" y="152" textAnchor="middle" fill="#cbd5e1" fontSize="11">Apply / open PR</text>
      </svg>
    </div>
  );
}

export default function DeploymentDocsPage() {
  const [activeSection, setActiveSection] = useState("overview");

  return (
    <div className="flex flex-col min-h-screen bg-[#030712] text-slate-200">
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-brand/5 blur-[150px] rounded-full pointer-events-none -z-10" />
      <div className="fixed bottom-0 right-0 w-[400px] h-[400px] bg-brand-blue/10 blur-[120px] rounded-full pointer-events-none -z-10" />

      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#030712]/80 backdrop-blur-md">
        <div className="container mx-auto px-6 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <Image src="/icon.png" width={24} height={24} alt="WorkspaceGPT" className="opacity-90" />
            <span className="font-bold text-white text-sm">WorkspaceGPT</span>
            <span className="text-slate-500 text-sm hidden sm:inline">/ Docs / Deployment</span>
          </Link>
          <nav className="hidden md:flex items-center gap-5 text-sm text-slate-400">
            <Link href="/docs" className="hover:text-white transition-colors">← All docs</Link>
            <a href="https://github.com/ritesh-kant/workspaceGPT" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
          </nav>
        </div>
      </header>

      <div className="container mx-auto px-4 sm:px-6 flex gap-0 lg:gap-10 flex-1">
        <aside className="hidden lg:block w-56 xl:w-64 flex-shrink-0 py-10">
          <div className="sticky top-24 space-y-1">
            <Link href="/docs" className="block px-3 mb-3 text-sm text-slate-400 hover:text-white">← Back to docs</Link>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 px-3">On this page</p>
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                onClick={() => setActiveSection(s.id)}
                className={`block px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeSection === s.id ? "bg-brand/10 text-brand font-medium" : "text-slate-400 hover:text-white hover:bg-white/5"
                }`}
              >
                {s.label}
              </a>
            ))}
          </div>
        </aside>

        <main className="flex-1 py-10 min-w-0 max-w-3xl">
          {/* ── Overview ─────────────────────────────────────── */}
          <SectionAnchor id="overview" />
          <section className="mb-16">
            <div className="mb-4"><Badge color="purple">Enterprise feature</Badge></div>
            <SectionTitle>Deployment Automation</SectionTitle>
            <SectionSubtitle>
              Turn the manual release checklist — syncing feature flags, env vars, and component
              versions across environments — into a reviewable, one-click pipeline. The model is
              inspired by AWS CodePipeline, and nothing is hardwired to one team&apos;s setup.
            </SectionSubtitle>

            <p className="text-slate-300 text-sm leading-relaxed mb-2">
              A deployment <strong className="text-white">pipeline</strong> has three parts: a{" "}
              <strong className="text-white">Source</strong> (where releases are described), ordered{" "}
              <strong className="text-white">Stages</strong>, and the <strong className="text-white">Actions</strong>{" "}
              inside each stage that do the work. WorkspaceGPT reads the source, computes a diff, and only
              writes after you approve it.
            </p>
            <PipelineDiagram />

            <div className="grid sm:grid-cols-3 gap-4">
              <Card icon="🧩" title="Pluggable" accent="purple">
                <p>Pick a source, then add only the deploy actions your org uses. No provider is baked in; Mars MMS is just a preset.</p>
              </Card>
              <Card icon="🛡️" title="Plan → Approve → Apply" accent="green">
                <p>Every change is previewed as a diff you approve. Backend changes open a pull request — never an auto-merge.</p>
              </Card>
              <Card icon="🔍" title="Discover &amp; select" accent="blue">
                <p>Repos, workflows, projects, and table columns are detected from your connected accounts — pick from dropdowns.</p>
              </Card>
            </div>
          </section>

          {/* ── Quickstart ───────────────────────────────────── */}
          <SectionAnchor id="quickstart" />
          <section className="mb-16">
            <SectionTitle>Quickstart</SectionTitle>
            <SectionSubtitle>Get a working pipeline in a few minutes by starting from a preset.</SectionSubtitle>
            <div className="space-y-0">
              <Step number={1} title="Enable the feature">
                <p>In the WorkspaceGPT sidebar, open <code className="bg-white/10 px-1 rounded text-xs">Settings → Deployment</code> and turn on the toggle.</p>
              </Step>
              <Step number={2} title="Load a preset">
                <p>Use the <strong className="text-white">Preset</strong> dropdown and choose a ready-made pipeline (or <strong className="text-white">Blank</strong> to start fresh). A preset pre-fills the source and actions — everything stays editable.</p>
              </Step>
              <Step number={3} title="Connect the providers it needs">
                <p>The <strong className="text-white">Connections</strong> section lists only what your pipeline uses. Connect those (see <a href="#connections" className="text-brand hover:underline">Connections &amp; permissions</a>).</p>
              </Step>
              <Step number={4} title="Run a release">
                <p>Open the <strong className="text-white">Releases</strong> panel (rocket icon), click <strong className="text-white">Plan</strong> to preview the diff, review it, then <strong className="text-white">Approve &amp; apply</strong>.</p>
              </Step>
            </div>
          </section>

          {/* ── Sources ──────────────────────────────────────── */}
          <SectionAnchor id="sources" />
          <section className="mb-16">
            <SectionTitle>Sources</SectionTitle>
            <SectionSubtitle>The source answers “what are we releasing today, and what config does it want?”</SectionSubtitle>

            <H3>Confluence roster</H3>
            <p className="text-slate-300 text-sm leading-relaxed mb-2">
              A wiki page with a table mapping each <strong className="text-white">date</strong> to a release{" "}
              <strong className="text-white">version</strong> (plus optional environment and pilot columns), and a
              per-release configuration table. WorkspaceGPT auto-detects the columns by their headers; if your
              headers are non-standard, open <strong className="text-white">Column mapping (auto-detected)</strong> and
              pick them from dropdowns populated by reading the page.
            </p>
            <Note color="blue">
              <span className="text-blue-400 font-semibold">Requires:</span> Confluence connected under{" "}
              <Link href="/docs#confluence" className="text-brand hover:underline">Settings → Confluence</Link>. The page is read with your existing Confluence auth.
            </Note>

            <H4>Config target routing</H4>
            <p className="text-slate-300 text-sm leading-relaxed mb-2">
              A Confluence configuration table names an app/system per row but has no explicit{" "}
              <code className="bg-white/10 px-1 rounded text-xs">target</code> column, so WorkspaceGPT decides
              whether each variable syncs to <strong className="text-white">Vercel</strong> or{" "}
              <strong className="text-white">mach</strong>. By default it uses judgment — a{" "}
              <code className="bg-white/10 px-1 rounded text-xs">NEXT_PUBLIC_</code>-prefixed or otherwise
              frontend-looking key routes to Vercel, generic backend config to mach. To pin specific apps, open{" "}
              <strong className="text-white">Config target routing</strong> on the Confluence source and add rules
              mapping an app/system name to a target. Each rule accepts several comma-separated names, matched as a
              case-insensitive substring; the first matching rule wins, and unmatched rows fall back to Vercel only
              if the name mentions “vercel”, otherwise mach.
            </p>

            <H3>JSON file (Git repo)</H3>
            <p className="text-slate-300 text-sm leading-relaxed mb-2">
              For teams that keep release info in version control instead of a wiki. Point the source at a repo,
              branch, and path; WorkspaceGPT reads it with the GitHub PAT. Expected shape:
            </p>
            <CodeBlock language="json">{`{
  "releases": [
    {
      "date": "2026-06-26",
      "version": "1.2.3",
      "environment": "stage",
      "pilot": "Jane Doe",
      "config": [
        { "key": "FEATURE_NEW_CHECKOUT", "value": "true", "target": "vercel" },
        { "key": "API_URL", "values": { "stage": "...", "prod": "..." }, "target": "mach" }
      ]
    }
  ]
}`}</CodeBlock>
            <p className="text-slate-400 text-sm">
              Use <code className="bg-white/10 px-1 rounded text-xs">value</code> for one value, or{" "}
              <code className="bg-white/10 px-1 rounded text-xs">values</code> to set per-environment values.{" "}
              <code className="bg-white/10 px-1 rounded text-xs">target</code> routes each var to an action (<code className="bg-white/10 px-1 rounded text-xs">vercel</code> or <code className="bg-white/10 px-1 rounded text-xs">mach</code>).
            </p>

            <H3>Manual / None</H3>
            <p className="text-slate-300 text-sm leading-relaxed">
              <strong className="text-white">Manual</strong> — you enter the version and environment at run time.{" "}
              <strong className="text-white">None</strong> — there&apos;s no config source; the desired state comes from
              the actions themselves (e.g. promoting component versions between environments).{" "}
              <Badge color="yellow">Jira source — coming soon</Badge>
            </p>
          </section>

          {/* ── Actions ──────────────────────────────────────── */}
          <SectionAnchor id="actions" />
          <section className="mb-16">
            <SectionTitle>Actions</SectionTitle>
            <SectionSubtitle>Each action is one deploy step, run by a provider. Add them to a stage and configure with dropdowns.</SectionSubtitle>
            <div className="overflow-x-auto rounded-2xl border border-white/10 mb-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-900">
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">Provider</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">What it does</th>
                    <th className="text-left px-5 py-3 text-slate-300 font-semibold">How it applies</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {[
                    { name: "Vercel — env config", does: "Pushes feature flags / env vars to a Vercel project for the target environment.", how: "Direct upsert via the Vercel API." },
                    { name: "GitHub — workflow dispatch", does: "Triggers a CI workflow that promotes component versions between environments.", how: "Opens a PR — never auto-merged." },
                    { name: "Repo — file patch", does: "Edits a config file in a repo (e.g. merging env vars into main.yml).", how: "Commits to the PR branch." },
                  ].map((row) => (
                    <tr key={row.name} className="bg-slate-950 hover:bg-slate-900/60 transition-colors align-top">
                      <td className="px-5 py-3 font-medium text-white">{row.name}</td>
                      <td className="px-5 py-3 text-slate-400">{row.does}</td>
                      <td className="px-5 py-3 text-slate-400">{row.how}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <H3>Backend env vars land on the sync PR</H3>
            <p className="text-slate-300 text-sm leading-relaxed mb-2">
              The <strong className="text-white">Vercel</strong> action diffs against live state and
              writes immediately. The backend is different: component versions and env vars live in a
              Git repo behind branch protection, so the <strong className="text-white">GitHub — workflow
              dispatch</strong> action opens a <strong className="text-white">sync pull request</strong>{" "}
              first. The <strong className="text-white">Repo — file patch</strong> action then diffs your
              release&apos;s backend env vars against <code className="bg-white/10 px-1 rounded text-xs">main.yml</code>{" "}
              <em>on that PR</em> — not the repo&apos;s default branch — and commits any add/update back to
              the same PR branch as one idempotent commit. A single PR ends up carrying both the
              component-version bumps and the env-var reconciliation.
            </p>
            <Note color="blue">
              <span className="text-blue-400 font-semibold">Ordering:</span> the file-patch step depends
              on the sync PR. Run the workflow-dispatch action first, wait for its PR to open, then plan
              the env vars. Until the PR exists, the step reports <em>&ldquo;no open sync PR&rdquo;</em>{" "}
              rather than diffing against the wrong branch.
            </Note>

            <p className="text-slate-400 text-sm mt-6">
              Reserved for future releases (the seams exist already): <strong className="text-slate-200">blue-green switch</strong>,{" "}
              <strong className="text-slate-200">canary</strong>, <strong className="text-slate-200">health verify</strong>, and{" "}
              <strong className="text-slate-200">rollback</strong>.
            </p>
          </section>

          {/* ── Connections ──────────────────────────────────── */}
          <SectionAnchor id="connections" />
          <section className="mb-16">
            <SectionTitle>Connections &amp; permissions</SectionTitle>
            <SectionSubtitle>The Settings page shows only the connections your pipeline actually needs.</SectionSubtitle>

            <H3>GitHub (Personal Access Token)</H3>
            <div className="space-y-0">
              <Step number={1} title="Create a classic PAT">
                <p>In GitHub → <strong className="text-white">Settings → Developer settings → Personal access tokens (classic)</strong>, create a token with scopes:</p>
                <p><Badge color="purple">repo</Badge> <Badge color="purple">workflow</Badge></p>
              </Step>
              <Step number={2} title="Authorize SSO (if your org requires it)">
                <p>On the token page, click <strong className="text-white">Configure SSO</strong> and authorize it for each organization that owns the repos. This is the most common cause of failures — an un-authorized token returns <code className="bg-white/10 px-1 rounded text-xs">404</code> on private repos rather than a clear error.</p>
              </Step>
              <Step number={3} title="Paste it into WorkspaceGPT">
                <p>In <code className="bg-white/10 px-1 rounded text-xs">Settings → Deployment → Connections</code>, paste the PAT. WorkspaceGPT validates reachability and shows a green check. The token is stored in encrypted secret storage — never echoed back.</p>
              </Step>
            </div>

            <H3>Vercel</H3>
            <p className="text-slate-300 text-sm leading-relaxed mb-2">
              Connect via one-click OAuth. In the Vercel action you then pick the <strong className="text-white">project</strong>{" "}
              from a dropdown and map each environment (e.g. <em>stage → Preview</em>, <em>prod → Production</em>).
            </p>
            <Note color="yellow">
              <span className="text-yellow-400 font-semibold">Known limit:</span> a Vercel integration token can&apos;t
              decrypt the values of variables it doesn&apos;t own. When that happens, WorkspaceGPT marks the current value
              as hidden and still classifies the change correctly (present → update, missing → add) — it just can&apos;t
              show the old value in the diff.
            </Note>

            <H3>Confluence</H3>
            <p className="text-slate-300 text-sm leading-relaxed">
              Reused from the <Link href="/docs#confluence" className="text-brand hover:underline">Confluence integration</Link>.
              Needed only when your source is a Confluence roster.
            </p>
          </section>

          {/* ── Releases workflow ────────────────────────────── */}
          <SectionAnchor id="releases" />
          <section className="mb-16">
            <SectionTitle>The Releases workflow</SectionTitle>
            <SectionSubtitle>Open the Releases panel (rocket icon in the title bar) to run a pipeline.</SectionSubtitle>
            <Note color="brand">
              Each pipeline appears as its own <strong className="text-white">color-coded card</strong> —{" "}
              <span className="text-blue-400 font-medium">Vercel</span>,{" "}
              <span className="text-purple-400 font-medium">mach components</span>, and{" "}
              <span className="text-cyan-400 font-medium">mach main.yml env vars</span> — each with a
              numbered header and a <strong className="text-white">step tracker</strong> (done ✓ /
              in-progress ● / pending ○). The color tells you which pipeline a button belongs to, and the
              tracker shows at a glance which step you&apos;re on.
            </Note>
            <div className="space-y-0 mt-6">
              <Step number={1} title="Resolve">
                <p>WorkspaceGPT reads the source and shows today&apos;s release — version, environment, and pilot. When a chat model is configured (<Link href="/docs#ai-providers" className="text-brand hover:underline">Settings → Model</Link>), it reads the roster with AI by default so it isn&apos;t tripped up by per-org column names or date formats; without a model it falls back to strict header matching.</p>
                <p className="mt-2">If the roster has a row for today but its <strong className="text-white">version cell is empty</strong>, that&apos;s not an error — WorkspaceGPT still shows the environment and pilot and asks you to supply the release yourself. Expand <strong className="text-white">Enter version / release page URL</strong> and use the tabs to either type a <strong className="text-white">version</strong> or paste a <strong className="text-white">release page URL</strong> directly (only one is needed — a URL skips the version-name page lookup). The same panel doubles as a version/environment override for testing.</p>
              </Step>
              <Step number={2} title="Plan">
                <p>Click <strong className="text-white">Plan</strong> to compute a diff against live state. Each variable is classified:</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <Badge color="green">add</Badge>
                  <Badge color="blue">update</Badge>
                  <Badge>match (no-op)</Badge>
                  <Badge color="red">conflict (needs ack)</Badge>
                </div>
              </Step>
              <Step number={3} title="Approve &amp; apply">
                <p>Review the diff and approve. The plan is recomputed server-side (the client diff is never trusted), conflicts block the apply, and only add/update changes are written.</p>
              </Step>
              <Step number={4} title="Backend → pull request">
                <p>Workflow-dispatch actions open a PR for human review and poll its status live — the run link and PR link appear as they become available. WorkspaceGPT never merges for you.</p>
              </Step>
              <Step number={5} title="Sync backend env vars (main.yml)">
                <p>Once the sync PR is open, the <strong className="text-white">mach main.yml env vars</strong> step diffs your release&apos;s backend env vars against <code className="bg-white/10 px-1 rounded text-xs">main.yml</code> on that PR and commits any add/update to the same PR branch. Review and merge the single PR to deploy — it carries both the component-version bumps and the env-var changes.</p>
              </Step>
              <Step number={6} title="Recent runs">
                <p>Each apply is recorded to a local audit log and surfaced under <strong className="text-white">Recent runs</strong>, with a <strong className="text-white">Retry failed</strong> option.</p>
              </Step>
            </div>
          </section>

          {/* ── Hotfix ───────────────────────────────────────── */}
          <SectionAnchor id="hotfix" />
          <section className="mb-16">
            <SectionTitle>Hotfix flow</SectionTitle>
            <SectionSubtitle>Ship an urgent fix by ticket, without a full release.</SectionSubtitle>
            <p className="text-slate-300 text-sm leading-relaxed mb-3">
              The hotfix flow is a <strong className="text-white">separate pipeline</strong> from the config-sync
              release — the magenta card at the bottom of the Releases panel. Instead of config variables, its unit
              of work is <strong className="text-white">tickets → commits → components → tags</strong>. It reuses the
              same <em>plan → approve → apply</em> spine: nothing is written until you approve, and the plan is
              recomputed server-side on apply.
            </p>
            <div className="space-y-0 mt-6">
              <Step number={1} title="Enter tickets">
                <p>Paste one or more hotfix ticket ids (comma- or space-separated), e.g. <code className="bg-white/10 px-1 rounded text-xs">D2C-123456</code>.</p>
              </Step>
              <Step number={2} title="Plan">
                <p>WorkspaceGPT searches the hotfix repo for commits whose message carries each ticket, then maps each commit to a component from its <strong className="text-white">Conventional-Commit scope</strong> (<code className="bg-white/10 px-1 rounded text-xs">fix(mms-bff): …</code> → <code className="bg-white/10 px-1 rounded text-xs">mms-bff</code>). For each component it derives the current base version and next <code className="bg-white/10 px-1 rounded text-xs">hotfix.N</code> from existing tags, and proposes a tag:</p>
                <CodeBlock language="text">mms-bff-v1.2.3-hotfix.1</CodeBlock>
                <p className="mt-2">Commits with no derivable component are listed as <strong className="text-white">skipped</strong> — never silently dropped.</p>
              </Step>
              <Step number={3} title="Approve &amp; apply">
                <p>On approve, WorkspaceGPT cherry-picks the commits onto a <code className="bg-white/10 px-1 rounded text-xs">hotfix/&lt;date&gt;</code> branch (via the GitHub Git Data API — a merge conflict stops the apply cleanly rather than writing a bad tree), then pushes a scoped tag and creates a GitHub Release per component. The release fires that component&apos;s deploy workflow. Tags and releases are idempotent, so <strong className="text-white">Retry failed</strong> is safe.</p>
              </Step>
            </div>
            <Note color="brand">
              If a component has never been tagged, WorkspaceGPT can&apos;t derive its base version — the card shows a
              <strong className="text-white"> base version needed</strong> field. Enter <code className="bg-white/10 px-1 rounded text-xs">X.Y.Z</code>
              and Re-plan to compute the tag. The engine never invents a version.
            </Note>
            <H4>Configuration</H4>
            <p className="text-slate-300 text-sm leading-relaxed">
              The hotfix repository, base branch, and tag template default from your GitHub workflow-dispatch action&apos;s
              repo topology (its release tags are repo-scoped), and can be overridden per install — the default tag
              template is <code className="bg-white/10 px-1 rounded text-xs">{'{component}-v{version}-hotfix.{n}'}</code>.
              Authentication reuses the same mach GitHub token
              (classic PAT, <code className="bg-white/10 px-1 rounded text-xs">repo</code> scope) — no extra connection.
            </p>
          </section>

          {/* ── Environments ─────────────────────────────────── */}
          <SectionAnchor id="environments" />
          <section className="mb-16">
            <SectionTitle>Environments &amp; promotion policy</SectionTitle>
            <SectionSubtitle>Declare your environments and the policy for each.</SectionSubtitle>
            <p className="text-slate-300 text-sm leading-relaxed mb-3">
              By default, promotions <strong className="text-white">never auto-merge</strong> — the safest behavior. In the{" "}
              <strong className="text-white">Environments</strong> section you can add an environment by name and opt it into
              auto-merge individually. Each stage also has a <strong className="text-white">gate</strong> (manual by default),
              so a release pauses for approval between stages.
            </p>
            <Note color="green">
              <span className="text-emerald-400 font-semibold">Tip:</span> leave environments empty unless you specifically
              want auto-merge for one of them. An empty list means every promotion waits for a human.
            </Note>
          </section>

          {/* ── AI ───────────────────────────────────────────── */}
          <SectionAnchor id="ai" />
          <section className="mb-16">
            <SectionTitle>AI-assisted page reading</SectionTitle>
            <SectionSubtitle>How WorkspaceGPT reads a wiki page whose structure varies per team and release.</SectionSubtitle>
            <p className="text-slate-300 text-sm leading-relaxed mb-3">
              Roster and release-page layouts differ too much between orgs for a strict header parser to be reliable, so
              when a chat model is configured (<Link href="/docs#ai-providers" className="text-brand hover:underline">Settings → Model</Link>) WorkspaceGPT reads pages with AI by
              default — both resolving today&apos;s release from the roster and extracting config variables during{" "}
              <strong className="text-white">Prepare config sync</strong>. Strict header matching is used only as a fallback
              when no model is configured.
            </p>
            <p className="text-slate-300 text-sm leading-relaxed mb-3">
              Two toggles on the Confluence source let you tune this: <strong className="text-white">AI-assisted page
              reading</strong> (roster resolution) and <strong className="text-white">Always use AI for config
              sync</strong> (release-page extraction). When reading the config table, the model also decides each
              variable&apos;s <strong className="text-white">target</strong> by judgment — inferring Vercel vs mach from the
              key&apos;s naming and the row&apos;s app/system context — and consults your{" "}
              <strong className="text-white">Config target routing</strong> rules when it isn&apos;t sure.
            </p>
            <Note color="green">
              <span className="text-emerald-400 font-semibold">AI proposes, you approve.</span> The model&apos;s output is
              validated (version looks real, targets known) and shown in the plan diff with its provenance — nothing is applied
              without your approval. It changes how a page is <em>read</em>, never how a change is decided or written.
            </Note>
          </section>

          {/* ── Security ──────────────────────────────────────── */}
          <SectionAnchor id="security" />
          <section className="mb-16">
            <SectionTitle>Security model</SectionTitle>
            <SectionSubtitle>Write access is treated with care.</SectionSubtitle>
            <ul className="list-disc list-inside text-slate-300 text-sm leading-relaxed space-y-2">
              <li>Write-scoped credentials (GitHub PAT, Vercel token) live only in VS Code&apos;s encrypted secret storage.</li>
              <li>They are never written to plaintext settings and never logged.</li>
              <li>They are <strong className="text-white">excluded from the Chrome share bundle</strong> — sharing your setup never shares your write creds.</li>
              <li>Nothing is applied without an explicit in-app approval; backend changes go through a pull request under branch protection.</li>
              <li>The apply re-computes the plan server-side and blocks on unresolved conflicts — the client&apos;s diff is never trusted.</li>
            </ul>
          </section>

          {/* ── Troubleshooting ──────────────────────────────── */}
          <SectionAnchor id="troubleshooting" />
          <section className="mb-16">
            <SectionTitle>Troubleshooting</SectionTitle>
            <SectionSubtitle>Issues specific to deployment automation.</SectionSubtitle>
            <div className="space-y-4">
              {[
                { problem: "“No release scheduled for today”", fix: "The source has no entry whose date matches today. Check the roster/file date format, or expand Enter version / release page URL in the Releases view and supply a version (or paste a release page URL) manually." },
                { problem: "“Release scheduled, but no version listed”", fix: "A roster row matches today but its version cell is blank. This isn't an error — expand Enter version / release page URL and either type the version or paste the release page URL. A URL routes straight to that page and skips the version-name lookup entirely." },
                { problem: "A config var synced to the wrong pipeline (mach vs Vercel)", fix: "Confluence config tables have no explicit target column, so the target is inferred from the key name and the row's app/system. To pin it, open Config target routing on the Confluence source and add a rule mapping that app/system name (comma-separated names allowed) to vercel or mach. Rules are checked in order, first match wins." },
                { problem: "GitHub returns 404 on a private repo", fix: "Your PAT almost certainly isn't SSO-authorized for that organization. Open the token's Configure SSO and authorize it for the org that owns the repo. A valid-but-unauthorized token returns 404, not 403." },
                { problem: "Vercel diff shows “(value hidden)”", fix: "Integration tokens can't decrypt values they don't own. The change is still classified correctly (update vs add); only the old value is hidden. This is a Vercel platform limit, not a bug." },
                { problem: "Roster columns not detected", fix: "Open Column mapping (auto-detected) under the Confluence source, click Detect columns, and pick the right header for each field. If the page structure changed, enable AI-assisted page reading." },
                { problem: "Dropdowns are empty (repos/workflows)", fix: "Make sure the GitHub PAT is saved and reaches the org. Use the ↻ Re-detect button in the action's Repo topology section after connecting." },
                { problem: "Backend run never appears after trigger", fix: "workflow_dispatch is asynchronous — the run takes a few seconds to register. WorkspaceGPT polls automatically; use the ↻ Recheck button if needed." },
                { problem: "main.yml env-var plan says “No open sync PR”", fix: "The backend env-var step diffs against the open sync PR, which the GitHub workflow-dispatch (mach sync) action creates. Trigger mach sync first, wait for the PR to open, then plan the main.yml env vars." },
                { problem: "Hotfix plan says a component needs a base version", fix: "That component has no released tag to derive vX.Y.Z from. Enter the base version in the component's field on the hotfix card, then Re-plan — WorkspaceGPT never invents a version." },
                { problem: "Hotfix: “no commits mapped to a component”", fix: "Commits are mapped by their Conventional-Commit scope, e.g. fix(mms-bff): …. Confirm the ticket id appears in the commit messages and that titles carry a (scope). Commits with no scope are listed as skipped." },
                { problem: "Hotfix cherry-pick reports a conflict", fix: "The commit doesn't apply cleanly onto the hotfix branch. WorkspaceGPT stops and restores the branch head rather than writing a bad tree — resolve the conflict manually (cherry-pick locally) for that component." },
              ].map((item) => (
                <details key={item.problem} className="group bg-slate-900 border border-white/5 rounded-2xl overflow-hidden">
                  <summary className="flex items-center justify-between px-5 py-4 cursor-pointer text-white font-medium hover:bg-white/5 transition-colors list-none">
                    <span className="flex items-center gap-3"><span className="text-yellow-400 text-sm">⚠</span>{item.problem}</span>
                    <svg className="w-4 h-4 text-slate-400 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <div className="px-5 pb-5 pt-1 text-sm text-slate-300 border-t border-white/5">{item.fix}</div>
                </details>
              ))}
            </div>
          </section>

          {/* ── FAQ ──────────────────────────────────────────── */}
          <SectionAnchor id="faq" />
          <section className="mb-16">
            <SectionTitle>FAQ</SectionTitle>
            <SectionSubtitle>Quick answers to common questions.</SectionSubtitle>
            <div className="space-y-4">
              {[
                { q: "Do I have to use Confluence?", a: "No. Pick the JSON file source to keep releases in a repo, or Manual to enter the version at run time. Confluence is one source among several." },
                { q: "Do I need the GitHub workflow (mach) action?", a: "No. It's just one action provider. A frontend-only team might use only the Vercel action; remove what you don't need." },
                { q: "Will it merge or deploy without me?", a: "Never. Frontend config is written only after you approve; backend changes open a pull request you merge yourself." },
                { q: "Can other teams reuse this?", a: "Yes — that's the point. Start from Blank, pick your source, add your actions, connect your accounts. Mars MMS is just a preset, not the only shape." },
                { q: "Where are my tokens stored?", a: "In VS Code's encrypted secret storage only. They're never in settings, never logged, and never shared via the Chrome bundle." },
              ].map((item) => (
                <details key={item.q} className="group bg-slate-900 border border-white/5 rounded-2xl overflow-hidden">
                  <summary className="flex items-center justify-between px-5 py-4 cursor-pointer text-white font-medium hover:bg-white/5 transition-colors list-none">
                    <span>{item.q}</span>
                    <svg className="w-4 h-4 text-slate-400 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </summary>
                  <div className="px-5 pb-5 pt-1 text-sm text-slate-300 border-t border-white/5">{item.a}</div>
                </details>
              ))}
            </div>

            <div className="mt-8 p-6 bg-slate-900 border border-white/5 rounded-2xl">
              <h4 className="text-white font-semibold mb-2">Still need help?</h4>
              <div className="flex flex-wrap gap-4 text-sm">
                <a href="https://github.com/ritesh-kant/workspaceGPT/issues" target="_blank" rel="noopener noreferrer" className="text-brand-blue hover:underline">Open a GitHub issue →</a>
                <a href="mailto:contact@workspacegpt.in" className="text-brand-blue hover:underline">Email support →</a>
              </div>
            </div>
          </section>
        </main>
      </div>

      <footer className="border-t border-white/5 py-8 bg-slate-950">
        <div className="container mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-slate-500">
          <p>© {new Date().getFullYear()} WorkspaceGPT. Proprietary Software.</p>
          <div className="flex gap-6">
            <Link href="/docs" className="hover:text-white transition-colors">All docs</Link>
            <Link href="/" className="hover:text-white transition-colors">Home</Link>
            <a href="mailto:contact@workspacegpt.in" className="hover:text-white transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
