import type {
  ReleaseSource,
  ResolvedRelease,
  DesiredConfigVar,
  Environment,
} from '@workspace-gpt/release-core';
import type { ParsedTable } from '@workspace-gpt/confluence-utils';
import { ConfluenceReleaseSource } from './confluenceReleaseSource';

/** A one-shot LLM completion: takes a prompt, returns the raw text response. */
export type LlmComplete = (prompt: string) => Promise<string>;

/**
 * How each parse uses the LLM:
 *  - `deterministic`: never call the LLM (pure header-matching parser).
 *  - `fallback`: deterministic first, AI only if it fails/returns nothing.
 *  - `always`: skip the deterministic parser and go straight to AI. Chosen for
 *    config sync when release-page layouts vary too much per-org for header
 *    matching to be reliable.
 */
export type AiMode = 'deterministic' | 'fallback' | 'always';

export interface AiReleaseSourceOptions {
  /** Roster date→version resolution. */
  resolveMode?: AiMode;
  /** "Prepare config sync" release-page parsing. */
  configMode?: AiMode;
}

/**
 * AI-assisted {@link ReleaseSource}. Robust to roster/release-page structure
 * changes (renamed/reordered columns, vocabulary drift) that break the
 * deterministic header-matching parser.
 *
 * Design — AI proposes, code validates, human approves:
 *  - Deterministic first. The wrapped {@link ConfluenceReleaseSource} runs; only
 *    if it fails (throws) or returns an implausible result do we call the LLM.
 *  - The LLM is given the page's *parsed tables* (digits preserved) plus a plain
 *    text fallback, and must answer in a fixed JSON schema.
 *  - Every AI result is validated deterministically (shape, version looks real,
 *    targets known). Bad output throws rather than silently feeding apply.
 *  - Provenance is carried back (per-var `note`, logged for resolve) so the
 *    human sees where each value came from in the plan review — which is the
 *    backstop, since nothing applies without that approval gate.
 */
export class AiReleaseSource implements ReleaseSource {
  private readonly resolveMode: AiMode;
  private readonly configMode: AiMode;

  constructor(
    private readonly inner: ConfluenceReleaseSource,
    private readonly llm: LlmComplete,
    opts: AiReleaseSourceOptions = {},
  ) {
    this.resolveMode = opts.resolveMode ?? 'fallback';
    this.configMode = opts.configMode ?? 'fallback';
  }

  async resolveRelease(date: string): Promise<ResolvedRelease | null> {
    if (this.resolveMode === 'deterministic') return this.inner.resolveRelease(date);

    // Deterministic first — cheap, exact, auditable.
    if (this.resolveMode === 'fallback') {
      try {
        const det = await this.inner.resolveRelease(date);
        if (det && /\d/.test(det.version)) return det;
      } catch {
        // fall through to AI
      }
    }

    const { tables, text } = await this.inner.getRosterContent();
    const obj = await this.ask(this.resolvePrompt(date, tables, text));
    return this.validateResolved(obj, date);
  }

  async fetchDesiredConfig(version: string, environment: Environment): Promise<DesiredConfigVar[]> {
    if (this.configMode === 'deterministic') {
      return this.inner.fetchDesiredConfig(version, environment);
    }

    // In `always` mode we skip deterministic parsing outright — release-page
    // layouts vary too much per-org for header matching to be trustworthy.
    if (this.configMode === 'fallback') {
      try {
        const det = await this.inner.fetchDesiredConfig(version, environment);
        if (det.length) return det;
      } catch {
        // fall through to AI
      }
    }

    const { tables, text } = await this.inner.getReleasePageContent(version);
    const obj = await this.ask(this.configPrompt(version, environment, tables, text));
    return this.validateVars(obj);
  }

  /* ----------------------------- internals ----------------------------- */

  /** Compact, digit-preserving rendering of the page for the prompt. */
  private renderContent(tables: ParsedTable[], text: string): string {
    if (tables.length) {
      return tables
        .map((t, i) => {
          const rows = t.rows.map((r) => r.join(' | ')).join('\n');
          return `Table ${i + 1}:\nColumns: ${t.headers.join(' | ')}\n${rows}`;
        })
        .join('\n\n');
    }
    // No tables parsed — fall back to plain text (truncated to keep tokens sane).
    return `PAGE TEXT:\n${text.slice(0, 12000)}`;
  }

  private resolvePrompt(date: string, tables: ParsedTable[], text: string): string {
    return [
      'You read a software Release Roster (a Confluence page) and extract the release scheduled for a given date.',
      `Target date: ${date} (format YYYY-MM-DD).`,
      'Find the row/entry whose date equals the target date and return ONLY a JSON object:',
      '{"version": <string version, e.g. "web-2026-6.2-rc.8">, "environment": <"stage" or "prod">, "pilot": <string or null>, "date": <"YYYY-MM-DD">, "provenance": <short string: which table/row you used>, "confidence": <0..1>}',
      'Rules: map "staging"->"stage", "production"->"prod". If NO release is scheduled for the target date, return {"version": null}. Do not invent a version. No markdown, JSON only.',
      '',
      this.renderContent(tables, text),
    ].join('\n');
  }

  private configPrompt(version: string, environment: Environment, tables: ParsedTable[], text: string): string {
    return [
      `You read a software release page for version "${version}" and extract its configuration variables for the "${environment}" environment.`,
      'Return ONLY a JSON array; each element:',
      '{"key": <string var/flag name>, "value": <string value for THIS environment>, "target": <"vercel" or "mach">, "sensitive": <boolean>, "note": <short provenance: which table/row>}',
      `Rules: pick the value from the column for the "${environment}" environment. Set "target" to "vercel" if the row's app/system mentions vercel, else "mach". Set "sensitive" true for secrets/tokens/passwords/api keys. Skip rows with no key or no value. No markdown, JSON only.`,
      '',
      this.renderContent(tables, text),
    ].join('\n');
  }

  /** Call the LLM and parse a JSON object/array out of the response. */
  private async ask(prompt: string): Promise<any> {
    const raw = await this.llm(prompt);
    // Strip reasoning blocks (thinking models such as gemini-2.5-* may emit
    // <think>…</think>) and markdown code fences before attempting to parse.
    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // Greedy match from the first bracket to the last — tolerates prose
      // wrapped around the JSON.
      const m = cleaned.match(/[[{][\s\S]*[\]}]/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch {
          /* noop */
        }
      }
      // Log the raw output for debugging and give an actionable hint that
      // distinguishes empty / truncated / non-JSON responses.
      console.warn('[AiReleaseSource] unparseable LLM output:', JSON.stringify(raw).slice(0, 2000));
      const hint =
        cleaned.length === 0
          ? 'The model returned an empty response — it likely spent its whole token budget on reasoning. Use a non-thinking model, or one with a larger output limit.'
          : /[[{]/.test(cleaned) && !/[\]}]\s*$/.test(cleaned)
            ? 'The response looks truncated (JSON cut off mid-way) — the output token limit was probably hit. Use a model with a larger output limit, or split the release page.'
            : 'The model did not return JSON.';
      throw new Error(`AI source returned output that is not valid JSON. ${hint}`);
    }
  }

  private validateResolved(obj: any, date: string): ResolvedRelease | null {
    if (!obj || obj.version == null) return null; // no release scheduled
    const version = String(obj.version).trim();
    if (!version || !/\d/.test(version)) {
      throw new Error(`AI source returned an implausible version: "${obj.version}".`);
    }
    const rawEnv = String(obj.environment ?? '').toLowerCase();
    const environment: Environment =
      /pr(o)?d|production/.test(rawEnv) ? 'prod' : /stag/.test(rawEnv) ? 'stage' : (obj.environment || 'stage');
    // Provenance is logged; the human-review gate is the real backstop.
    console.log(
      `[AiReleaseSource] resolved ${version} (${environment}) — ${obj.provenance ?? 'no provenance'} · confidence ${obj.confidence ?? '?'}`,
    );
    return {
      version,
      environment,
      pilot: obj.pilot ? String(obj.pilot) : undefined,
      date: obj.date ? String(obj.date) : date,
    };
  }

  private validateVars(obj: any): DesiredConfigVar[] {
    if (!Array.isArray(obj)) {
      throw new Error('AI source returned a non-array for the config variables.');
    }
    const out: DesiredConfigVar[] = [];
    for (const r of obj) {
      const key = r?.key != null ? String(r.key).trim() : '';
      const value = r?.value != null ? String(r.value) : '';
      if (!key || value === '') continue;
      const target = r?.target === 'vercel' ? 'vercel' : 'mach';
      out.push({
        key,
        value,
        target,
        sensitive: !!r?.sensitive,
        note: r?.note ? `AI: ${String(r.note)}` : 'AI-extracted',
      });
    }
    return out;
  }
}
