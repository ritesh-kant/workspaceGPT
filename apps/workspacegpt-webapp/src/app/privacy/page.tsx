import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy - WorkspaceGPT",
  description:
    "How the WorkspaceGPT browser extension and VS Code extension handle your data.",
};

const UPDATED = "June 25, 2026";

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
          WorkspaceGPT is a privacy-first AI assistant that lets you ask questions about
          your own Confluence and Azure DevOps knowledge base. This policy explains what
          data the WorkspaceGPT browser extension (the &ldquo;Extension&rdquo;) processes
          and where it goes. We&rsquo;ve written it to match exactly how the Extension
          behaves.
        </p>

        <Section title="The short version">
          <ul className="list-disc pl-6 space-y-2">
            <li>
              We do <strong>not</strong> operate a server that collects, stores, or sees
              your data. The Extension talks directly from your browser to the services
              you connect it to.
            </li>
            <li>We do not sell your data or use it for advertising.</li>
            <li>
              Your connection settings stay in your browser&rsquo;s local extension
              storage and never leave your device except to reach the services below.
            </li>
          </ul>
        </Section>

        <Section title="What the Extension processes">
          <p>
            <strong>Your questions.</strong> When you ask a question, the text you type is
            sent to the AI and search services connected through your share code so the
            Extension can find relevant documents and generate an answer.
          </p>
          <p>
            <strong>Connection settings (share code).</strong> The share code you paste
            from the WorkspaceGPT VS Code extension contains the endpoint and credentials
            for your knowledge base (for example, your vector-search URL and AI provider
            API key). These are stored locally using the browser&rsquo;s extension storage
            (<code className="text-brand">chrome.storage</code>) and are used only to
            connect to those services. They are not transmitted to us.
          </p>
        </Section>

        <Section title="Third-party services your data may reach">
          <p>
            Depending on the configuration in your share code, the Extension sends your
            query (and the documents retrieved for it) directly to the following services.
            Each processes data under its own privacy policy:
          </p>
          <ul className="list-disc pl-6 space-y-2">
            <li>
              <strong>Google Gemini</strong> (generativelanguage.googleapis.com) — to turn
              your question into a search embedding.
            </li>
            <li>
              <strong>Qdrant</strong> (your *.qdrant.io instance) — to search your indexed
              knowledge base.
            </li>
            <li>
              <strong>Your configured LLM provider</strong> — one of OpenAI, Groq,
              OpenRouter, or NVIDIA — to generate the final answer from the retrieved
              context.
            </li>
          </ul>
          <p>
            The Extension only contacts the providers present in your configuration. We do
            not add or substitute any others.
          </p>
        </Section>

        <Section title="What we do not do">
          <ul className="list-disc pl-6 space-y-2">
            <li>We do not run analytics or tracking inside the Extension.</li>
            <li>We do not sell or share your data with third parties for their own use.</li>
            <li>
              We do not use your data for any purpose unrelated to answering your
              questions, and never for creditworthiness or lending decisions.
            </li>
          </ul>
        </Section>

        <Section title="Data retention">
          <p>
            Your connection settings persist in local extension storage until you remove
            them or uninstall the Extension. Questions are processed in real time and are
            not retained by the Extension. Retention by the third-party services above is
            governed by their respective policies.
          </p>
        </Section>

        <Section title="Your choices">
          <p>
            You can disconnect at any time by clearing the share code in the
            Extension&rsquo;s settings, or by uninstalling the Extension, which removes all
            locally stored settings.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Questions about this policy? Email us at{" "}
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
