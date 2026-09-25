import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "WorkspaceGPT's zero-retention privacy policy: your documents, code, and search index never leave your machine, and we store no prompts or answers in either Local or Remote mode.",
  alternates: {
    canonical: "/privacy",
  },
};

const UPDATED = "September 25, 2026";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-white mb-3">{title}</h2>
      <div className="space-y-3 text-slate-300 leading-relaxed">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#030712] text-slate-100">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/" className="text-sm text-brand hover:underline">
          ← Back to home
        </Link>

        <h1 className="mt-6 text-3xl font-bold text-white">Privacy Policy</h1>
        <p className="mt-2 text-sm text-slate-500">Last updated: {UPDATED}</p>

        <p className="mt-6 text-slate-300 leading-relaxed">
          WorkspaceGPT is a privacy-first AI assistant that lets you ask questions about your
          own codebase, Confluence pages, Jira issues and Azure DevOps work items. This policy
          describes what data the WorkspaceGPT IDE extension (VS Code, Cursor, Antigravity), the
          WorkspaceGPT Desktop app for macOS, and the WorkspaceGPT browser companion actually
          process, and where it goes. It is written to
          match how the software behaves, not to describe an aspiration.
        </p>

        <div className="mt-8 rounded-2xl border border-brand/20 bg-brand/5 p-6">
          <h2 className="text-lg font-semibold text-white mb-3">The short version</h2>
          <ul className="list-disc pl-6 space-y-2 text-slate-300">
            <li>
              <strong className="text-white">Your content stays on your machine.</strong> Your
              documents and work items are indexed on-device, and the resulting vector index is
              written to local files on your machine (your IDE&rsquo;s storage, or the Desktop
              app&rsquo;s data folder). Source code is read where it is and is not indexed. We never
              upload, copy, or index your content on our infrastructure.
            </li>
            <li>
              <strong className="text-white">Zero data retention.</strong> We store no prompts,
              no answers, no retrieved snippets, and no documents &mdash; not in a database, not
              in a file, not in logs.
            </li>
            <li>
              <strong className="text-white">No training, no selling, no ads.</strong> Nothing
              you ask is used to train a model, sold, or shared for anyone else&rsquo;s purposes.
            </li>
            <li>
              <strong className="text-white">Local mode needs no account</strong> and, with a
              local model, sends none of your content anywhere. The extension does send anonymous
              product-usage events in both modes &mdash; see{" "}
              <a href="#analytics" className="text-brand hover:underline">Analytics</a> for exactly
              what those contain.
            </li>
          </ul>
        </div>

        <Section title="The two modes, and what each one sends">
          <p>
            The mode you pick in <code className="text-brand">Settings → Mode</code> changes one
            thing: where the answer is generated. It never changes where your content is stored.
          </p>

          <div className="rounded-2xl border border-white/10 overflow-hidden mt-4">
            <div className="border-b border-white/10 bg-slate-900 px-5 py-3">
              <h3 className="font-semibold text-white">Local mode</h3>
            </div>
            <div className="px-5 py-4 space-y-2 text-sm">
              <p>
                Indexing, embeddings, retrieval and inference all happen on your machine. With a
                local model (Ollama), <strong className="text-white">nothing leaves your computer</strong>.
              </p>
              <p>
                If you choose to configure your own third-party model key instead (OpenAI,
                Google Gemini, Groq, OpenRouter, NVIDIA, or a custom OpenAI-compatible
                endpoint), then your question and the snippets retrieved for it are sent
                directly from your machine to <em>that</em> provider, under your own account and
                their privacy policy. WorkspaceGPT is not in the path and never sees the request.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 overflow-hidden mt-4">
            <div className="border-b border-white/10 bg-slate-900 px-5 py-3 flex items-center gap-3">
              <h3 className="font-semibold text-white">Remote mode</h3>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border bg-brand/10 text-brand border-brand/20">
                Preview
              </span>
            </div>
            <div className="px-5 py-4 space-y-2 text-sm">
              <p>
                We operate the inference infrastructure and choose the model, so you never
                supply a model key. Indexing and retrieval still happen entirely on your
                machine.
              </p>
              <p>
                What is sent to us: <strong className="text-white">your question, the snippets
                our local retrieval selected for it, and the conversation turns needed for
                context</strong> &mdash; passed to our endpoint at request time and forwarded to
                the upstream model provider. It is processed in memory and discarded when the
                response finishes. It is never written to a database or a log.
              </p>
              <p>
                What is <em>not</em> sent: your vector index, your repository, your Confluence
                or Azure DevOps corpus, or any credential for those systems.
              </p>
              <p className="text-slate-400">
                Remote mode is in preview and its behaviour may change; this policy will be
                updated before any change to what is transmitted or retained.
              </p>
            </div>
          </div>
        </Section>

        <Section title="Everything we store (Remote mode accounts)">
          <p>
            Remote mode requires a WorkspaceGPT account, created by signing in with GitHub. This
            is the complete list of what our servers hold. There is nothing else:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong className="text-white">Your GitHub numeric user id and login handle</strong>,
              plus the account-creation date GitHub reports &mdash; used to identify your account
              and to reject brand-new accounts created for abuse.
            </li>
            <li>
              <strong className="text-white">Your plan and account status</strong> (for example
              &ldquo;free&rdquo; / &ldquo;active&rdquo;).
            </li>
            <li>
              <strong className="text-white">An opaque session token</strong>, so you stay signed
              in. It expires automatically after 30 days and is deleted when you sign out.
            </li>
            <li>
              <strong className="text-white">How many credits you have used this week</strong>, to
              enforce your plan&rsquo;s weekly allowance. A number only &mdash; not what you asked.
            </li>
          </ul>
          <p>
            We request only the <code className="text-brand">read:user</code> scope from GitHub.
            We never receive access to your repositories, and the extension never even sees your
            GitHub token &mdash; our server completes the sign-in exchange and hands back only its
            own session token.
          </p>
        </Section>

        <Section title="Logging">
          <p>
            Our inference endpoint does not log request or response bodies. Operational errors
            are recorded as a status code and an error type &mdash; never your prompt, never the
            model&rsquo;s answer, never the retrieved content.
          </p>
        </Section>

        <Section title="Upstream model provider">
          <p>
            In Remote mode, the actual text generation is performed by an upstream model
            provider (currently <strong className="text-white">OpenRouter</strong>, which routes
            to the model we select). Your question and the retrieved snippets reach that provider
            in order to produce an answer, and are handled under its own privacy and retention
            policy.
          </p>
          <p>
            We state this plainly rather than claiming end-to-end zero retention on someone
            else&rsquo;s behalf: <strong className="text-white">WorkspaceGPT retains nothing</strong>,
            and we do not opt our provider account into any prompt-logging or data-sharing
            programme, but that provider &mdash; not us &mdash; is the authority on its own
            handling. If your organisation needs
            a contractual zero-retention guarantee across the whole path, use Local mode with a
            local model, which involves no third party at all.
          </p>
        </Section>

        <Section title="Connected data sources">
          <p>
            When you connect Confluence, Jira, Azure DevOps, GitHub, or Vercel, authentication happens
            directly between your machine and that service (OAuth, or a token you paste). The
            resulting credentials are stored in your IDE&rsquo;s encrypted secret storage (in the
            macOS Keychain for WorkspaceGPT Desktop) on your own device and are never transmitted
            to us. Content synced from those sources is
            indexed locally.
          </p>
        </Section>

        <div id="analytics" className="-mt-20 pt-20" />
        <Section title="Analytics">
          <p>
            The extension and WorkspaceGPT Desktop send anonymous product-usage events to{" "}
            <strong className="text-white">PostHog</strong> (EU-hosted) to understand which
            features are used. This happens in <strong className="text-white">both</strong> Local
            and Remote mode.
          </p>
          <p>Each event contains:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              An event name describing an action &mdash; for example{" "}
              <code className="text-brand">ado_sync_started</code>,{" "}
              <code className="text-brand">chat_turn</code>,{" "}
              <code className="text-brand">remote_sign_in_started</code>.
            </li>
            <li>
              A random identifier generated on your machine on first run. It is not derived from
              your name, email, GitHub account, IP address, or machine id, and we cannot use it to
              identify you.
            </li>
            <li>
              The extension version, your editor version, and whether the event came from the
              editor extension or WorkspaceGPT Desktop.
            </li>
            <li>
              Occasionally a coarse, non-identifying attribute of the action &mdash; for example
              which mode was active, or that a message was blocked because no model was selected.
            </li>
          </ul>
          <p>
            These events contain <strong className="text-white">no prompt text, no answers, no
            file contents, no file paths, no document titles, and no source-code identifiers</strong>.
            They tell us that a feature was used, never what you used it on.
          </p>
          <p>
            This website uses Vercel Analytics, which is cookie-less and does not build a profile
            of you.
          </p>
        </Section>

        <Section title="Browser companion (Chrome)">
          <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-4 text-sm">
            <p className="text-yellow-400 font-semibold">Pairing is currently unavailable.</p>
            <p className="text-slate-300 mt-1">
              The browser companion reads your search index directly, which now lives only on
              your machine, so new setups cannot be paired. The section below describes how
              existing installs behave.
            </p>
          </div>
          <p className="mt-4">
            The browser companion holds no server of ours. It is configured by pasting a
            &ldquo;share code&rdquo; generated in the IDE extension, containing the endpoint and
            credentials for a cloud-reachable index and model of your own. Those settings live in
            your browser&rsquo;s extension storage
            (<code className="text-brand">chrome.storage</code>) on your device, are used only to
            reach the services named in them, and are never transmitted to us. Your questions go
            from your browser straight to those services. Write-scoped credentials (GitHub,
            Vercel, Confluence, Azure DevOps) are deliberately excluded from a share code.
          </p>
          <p>
            Clearing the share code in the companion&rsquo;s settings, or uninstalling it, removes
            all locally stored settings.
          </p>
        </Section>

        <Section title="What we never do">
          <ul className="list-disc pl-6 space-y-2">
            <li>Store your prompts, answers, documents, code, or vector index.</li>
            <li>Use your data to train or fine-tune any model.</li>
            <li>Sell or share your data for anyone else&rsquo;s purposes.</li>
            <li>
              Use your data for any purpose unrelated to answering your questions, and never for
              creditworthiness or lending decisions.
            </li>
            <li>Require an account, a network connection, or telemetry for Local mode.</li>
          </ul>
        </Section>

        <Section title="Your choices">
          <p>
            Switch to Local mode at any time &mdash; it needs no account and, with a local model,
            makes no external calls. Signing out of Remote mode deletes your session token
            immediately. To delete your account and the handful of fields listed above, email us
            and we will remove them.
          </p>
          <p>
            <code className="text-brand">Settings → Reset</code> in the extension clears your
            local index and stored settings from your machine.
          </p>
          <p>
            The usage analytics described above do not yet have an in-extension toggle. If you
            want them off, block{" "}
            <code className="text-brand">eu.i.posthog.com</code> at your network or firewall, or
            email us and we will exclude your identifier.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            If we change what is transmitted or retained, we will update this page and its
            &ldquo;last updated&rdquo; date before the change takes effect.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about this policy, or a data-deletion request? Email{" "}
            <a href="mailto:contact@workspacegpt.in" className="text-brand hover:underline">
              contact@workspacegpt.in
            </a>
            .
          </p>
        </Section>
      </div>
    </main>
  );
}
