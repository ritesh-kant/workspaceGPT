import { parseStorageTables, type ParsedTable } from '@workspace-gpt/confluence-utils';
import type {
  ReleaseSource,
  ResolvedRelease,
  DesiredConfigVar,
  Environment,
} from '@workspace-gpt/release-core';
import { ConfluenceAuthService } from '../confluence/confluenceAuthService';

/**
 * Org-specific knowledge the engine must NOT hold (design §4.2): which columns
 * mean what, how page environments map to engine environments, and which
 * `App/System` values route to which config target. All defaults are
 * overridable so another org adopts this without editing the core.
 */
export interface ConfluenceReleaseSourceOptions {
  /** URL of the Release Roster page (date → version). */
  rosterPageUrl: string;
  /** Engine environment to assume when the roster has no environment column. */
  defaultEnvironment?: Environment;
  /**
   * Maps a Configurations-row `App/System` value to a config target id.
   * Default: anything containing "vercel" → `vercel`, everything else → `mach`.
   * (Open item #2 in the design doc — refine once the real mapping is known.)
   */
  targetFor?: (appSystem: string) => string;
  /**
   * Explicit roster column names, overriding header auto-detection. Set via the
   * discover-and-select dropdowns so an org whose roster uses non-standard
   * headers works without code changes. Any omitted column falls back to the
   * fuzzy auto-detect, so an unset mapping behaves exactly as before.
   */
  columns?: { date?: string; version?: string; env?: string; pilot?: string };
}

/** Resolve a Confluence page id out of a page URL or a bare id. */
export function pageIdFromUrl(urlOrId: string): string | null {
  const trimmed = (urlOrId || '').trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  // .../wiki/spaces/KEY/pages/<id>/Title  or  .../pages/viewpage.action?pageId=<id>
  const fromPath = trimmed.match(/\/pages\/(\d+)/);
  if (fromPath) return fromPath[1];
  const fromQuery = trimmed.match(/[?&]pageId=(\d+)/);
  if (fromQuery) return fromQuery[1];
  return null;
}

/**
 * Normalise common roster date spellings to ISO `YYYY-MM-DD`, or null if the
 * cell isn't a date. Kept liberal — rosters are hand-authored.
 */
export function normalizeDate(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;

  // Already ISO (optionally with time) → take the date part.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const mon = (m: string) => months[m.slice(0, 3).toLowerCase()];

  // "23 Jun 2026" / "23 June 2026"
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/);
  if (m && mon(m[2])) return `${m[3]}-${mon(m[2])}-${m[1].padStart(2, '0')}`;

  // "Jun 23, 2026" / "June 23 2026"
  m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && mon(m[1])) return `${m[3]}-${mon(m[1])}-${m[2].padStart(2, '0')}`;

  // Last resort: let the engine try; reject if it can't.
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }
  return null;
}

/** First header (lower-cased) matching `re`, else null. */
function findCol(headers: string[], re: RegExp): string | null {
  const hit = headers.find((h) => re.test(h.toLowerCase()));
  return hit ? hit.toLowerCase().trim() : null;
}

/**
 * Builds a `targetFor` from the org's Settings → Deployment Automation
 * "Config target routing" rules: each rule's `pattern` is one or more
 * comma-separated names; a row matches if the row's application/system name
 * contains ANY of them (case-insensitive substring). Rules are checked in
 * order — first match wins. The column holding that name is org-specific;
 * this deterministic path gets it from the auto-detected header, while the
 * AI path infers it from row content. Returns `undefined` when there are no
 * rules, so the caller's built-in "mentions vercel" default applies unchanged.
 */
export function buildTargetFor(
  targetMap?: { pattern: string; target: string }[],
): ((appSystem: string) => string) | undefined {
  const rules = (targetMap || [])
    .map((r) => ({ tokens: splitPatternTokens(r.pattern), target: r.target }))
    .filter((r) => r.tokens.length);
  if (!rules.length) return undefined;
  return (appSystem: string) => {
    const s = (appSystem || '').toLowerCase();
    for (const r of rules) {
      if (r.tokens.some((t) => s.includes(t))) return r.target;
    }
    return /vercel/i.test(appSystem) ? 'vercel' : 'mach';
  };
}

/** Split a rule's pattern into lower-cased, trimmed, non-empty comma-separated tokens. */
function splitPatternTokens(pattern: string): string[] {
  return (pattern || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * `ReleaseSource` backed by Confluence: a Roster page (date → version) plus a
 * per-release Configurations table. Reads only — touches nothing live.
 */
export class ConfluenceReleaseSource implements ReleaseSource {
  constructor(
    private readonly auth: ConfluenceAuthService,
    private readonly opts: ConfluenceReleaseSourceOptions,
  ) {}

  private targetFor(appSystem: string): string {
    if (this.opts.targetFor) return this.opts.targetFor(appSystem);
    return /vercel/i.test(appSystem) ? 'vercel' : 'mach';
  }

  /** GET a page's raw storage-format HTML body. */
  private async fetchPageHtml(pageId: string): Promise<string> {
    const token = await this.auth.getValidAccessToken();
    const site = this.auth.getStoredSite();
    if (!site) throw new Error('No Confluence site connected.');

    const url = `https://api.atlassian.com/ex/confluence/${site.id}/wiki/api/v2/pages/${pageId}?body-format=storage`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Confluence page ${pageId} fetch failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const data: any = await res.json();
    return data?.body?.storage?.value ?? '';
  }

  /** GET a page's storage-format body, parsed into tables. */
  private async fetchTables(pageId: string): Promise<ParsedTable[]> {
    return parseStorageTables(await this.fetchPageHtml(pageId));
  }

  /** Strip storage-format tags to plain text, preserving digits (unlike the
   * RAG text extractor). A coarse fallback signal for the AI source when a page
   * has no parseable tables. */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Raw content of the roster page for AI extraction (tables + plain text). */
  async getRosterContent(): Promise<{ tables: ParsedTable[]; text: string }> {
    const pageId = pageIdFromUrl(this.opts.rosterPageUrl);
    if (!pageId) throw new Error('Could not read a page id from the Release Roster URL.');
    const html = await this.fetchPageHtml(pageId);
    return { tables: parseStorageTables(html), text: this.stripHtml(html) };
  }

  /** Raw content of the release page for a version (tables + plain text). */
  async getReleasePageContent(
    version: string,
    pageUrlOverride?: string,
  ): Promise<{ tables: ParsedTable[]; text: string }> {
    const pageId = await this.resolvePageId(version, pageUrlOverride);
    if (!pageId) throw new Error(`Could not find a Confluence release page for "${version}".`);
    const html = await this.fetchPageHtml(pageId);
    return { tables: parseStorageTables(html), text: this.stripHtml(html) };
  }

  /**
   * Resolve the release page id: a caller-supplied page URL wins outright
   * (bypasses the title search entirely — useful when the version string
   * doesn't match the roster's release-page naming convention, or there is
   * no version at all yet). Otherwise fall back to the version-based search.
   */
  private async resolvePageId(version: string, pageUrlOverride?: string): Promise<string | null> {
    if (pageUrlOverride) return pageIdFromUrl(pageUrlOverride);
    return this.findReleasePageId(version);
  }

  /** Run a CQL query and return the first matching page id, or null. */
  private async searchFirstPageId(cql: string): Promise<string | null> {
    const token = await this.auth.getValidAccessToken();
    const site = this.auth.getStoredSite();
    if (!site) throw new Error('No Confluence site connected.');

    const url = `https://api.atlassian.com/ex/confluence/${site.id}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const first = data?.results?.[0];
    return first?.content?.id ?? first?.id ?? null;
  }

  /**
   * Find the release page id for a version. The roster carries an `-rc.N`
   * release-candidate suffix (e.g. `web-2026-6.2-rc.7`) but the release page is
   * titled without it (`web-2026-6.2`), so we strip the suffix and prefer an
   * exact title match, falling back to a contains match then the raw version.
   */
  private async findReleasePageId(version: string): Promise<string | null> {
    const base = version.replace(/-rc\.?\d+$/i, '').trim() || version;
    const queries = [
      `type=page and title = "${base}"`,
      `type=page and title ~ "${base}"`,
    ];
    if (base !== version) queries.push(`type=page and title ~ "${version}"`);

    for (const cql of queries) {
      const id = await this.searchFirstPageId(cql);
      if (id) return id;
    }
    return null;
  }

  /**
   * Introspect the roster page for the column-mapping dropdowns: return the
   * detected roster table's headers plus a best-guess mapping. Read-only.
   */
  async describeRoster(): Promise<{
    headers: string[];
    guess: { date?: string; version?: string; env?: string; pilot?: string };
  }> {
    const pageId = pageIdFromUrl(this.opts.rosterPageUrl);
    if (!pageId) throw new Error('Could not read a page id from the Release Roster URL.');
    const tables = await this.fetchTables(pageId);
    const roster = tables.find((t) => findCol(t.headers, /date|day|schedule/)) ?? tables[0];
    if (!roster) return { headers: [], guess: {} };
    const g = (re: RegExp) => roster.headers.find((h) => re.test(h.toLowerCase()));
    return {
      headers: roster.headers,
      guess: {
        date: g(/date|day|schedule/),
        version: g(/version|build|rc\b/) ?? g(/^release$|release(?!.*date)/),
        env: g(/\benv|environment/),
        pilot: g(/pilot|owner|engineer|on.?call|lead|responsible/),
      },
    };
  }

  async resolveRelease(date: string): Promise<ResolvedRelease | null> {
    const pageId = pageIdFromUrl(this.opts.rosterPageUrl);
    if (!pageId) {
      throw new Error('Could not read a page id from the Release Roster URL.');
    }

    const tables = await this.fetchTables(pageId);
    // Pick the first table that has a date-like column — the roster.
    const roster = tables.find((t) => findCol(t.headers, /date|day|schedule/));
    if (!roster) {
      throw new Error('No date column found on the Release Roster page.');
    }

    // Prefer an explicit (configured) column when it actually exists on the page;
    // otherwise fall back to the fuzzy auto-detect.
    const col = (override: string | undefined, re: RegExp): string | null => {
      const o = override?.toLowerCase().trim();
      if (o && roster.headers.some((h) => h.toLowerCase().trim() === o)) return o;
      return findCol(roster.headers, re);
    };
    const cols = this.opts.columns ?? {};
    const dateCol = col(cols.date, /date|day|schedule/);
    if (!dateCol) throw new Error('No date column found on the Release Roster page.');
    const versionCol =
      col(cols.version, /version|build|rc\b/) ??
      findCol(roster.headers, /^release$|release(?!.*date)/);
    const envCol = col(cols.env, /\benv|environment/);
    const pilotCol = col(cols.pilot, /pilot|owner|engineer|on.?call|lead|responsible/);

    const row = roster.records.find((r) => normalizeDate(r[dateCol]) === date);
    if (!row) return null; // No release scheduled today — not an error.

    const rawEnv = (envCol && row[envCol]?.trim()) || '';
    const environment: Environment =
      /\bpr(o)?d|production/i.test(rawEnv) ? 'prod'
        : /\bst(a)?g|stage|staging/i.test(rawEnv) ? 'stage'
        : rawEnv || this.opts.defaultEnvironment || 'stage';
    const pilot = (pilotCol && row[pilotCol]?.trim()) || undefined;

    const version = (versionCol && row[versionCol]?.trim()) || '';
    if (!version) {
      // Row exists for today but the version cell is empty — not an error,
      // the caller surfaces this so the user can fill it in manually.
      return { version: '', environment, pilot, date, needsVersion: true };
    }

    return {
      version,
      environment,
      pilot,
      date,
      pageUrl: this.opts.rosterPageUrl,
    };
  }

  async fetchDesiredConfig(
    version: string,
    environment: Environment,
    pageUrl?: string,
  ): Promise<DesiredConfigVar[]> {
    const pageId = await this.resolvePageId(version, pageUrl);
    if (!pageId) {
      throw new Error(
        pageUrl
          ? `Could not read a page id from the release page URL "${pageUrl}".`
          : `Could not find a Confluence release page for "${version}".`,
      );
    }

    const tables = await this.fetchTables(pageId);
    // The Configurations table: has a key/name column and a value/env column.
    const table = tables.find(
      (t) =>
        findCol(t.headers, /^key$|name|variable|flag|config/) &&
        findCol(t.headers, /value|stage|prod|production/),
    );
    if (!table) {
      throw new Error(`No Configurations table found on the release page for "${version}".`);
    }

    const keyCol = findCol(table.headers, /^key$|name|variable|flag/)!;
    const appCol = findCol(table.headers, /app|system|target|service/);
    // Prefer an environment-specific column; fall back to a generic "value".
    const envCol =
      (environment === 'prod'
        ? findCol(table.headers, /prod|production/)
        : findCol(table.headers, /stag|stage/)) ?? findCol(table.headers, /^value$|value/);
    if (!envCol) {
      throw new Error(`No value column for environment "${environment}" on the release page.`);
    }

    const vars: DesiredConfigVar[] = [];
    for (const r of table.records) {
      const key = r[keyCol]?.trim();
      const value = r[envCol]?.trim();
      if (!key || value === undefined || value === '') continue;
      vars.push({
        key,
        target: this.targetFor(appCol ? r[appCol] ?? '' : ''),
        value,
        sensitive: /secret|token|password|api[_-]?key/i.test(key),
      });
    }
    return vars;
  }
}
