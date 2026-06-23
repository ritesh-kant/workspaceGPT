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

  /** GET a page's storage-format body, parsed into tables. */
  private async fetchTables(pageId: string): Promise<ParsedTable[]> {
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
    const html: string = data?.body?.storage?.value ?? '';
    return parseStorageTables(html);
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
   * release-candidate suffix (e.g. `mms-2026-6.2-rc.7`) but the release page is
   * titled without it (`mms-2026-6.2`), so we strip the suffix and prefer an
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

    const dateCol = findCol(roster.headers, /date|day|schedule/)!;
    const versionCol =
      findCol(roster.headers, /version|build|rc\b/) ??
      findCol(roster.headers, /^release$|release(?!.*date)/);
    const envCol = findCol(roster.headers, /\benv|environment/);
    const pilotCol = findCol(roster.headers, /pilot|owner|engineer|on.?call|lead|responsible/);

    const row = roster.records.find((r) => normalizeDate(r[dateCol]) === date);
    if (!row) return null; // No release scheduled today — not an error.

    const version = (versionCol && row[versionCol]?.trim()) || '';
    if (!version) {
      throw new Error(`Found today's roster row but no version column (headers: ${roster.headers.join(', ')}).`);
    }

    const rawEnv = (envCol && row[envCol]?.trim()) || '';
    const environment: Environment =
      /\bpr(o)?d|production/i.test(rawEnv) ? 'prod'
        : /\bst(a)?g|stage|staging/i.test(rawEnv) ? 'stage'
        : rawEnv || this.opts.defaultEnvironment || 'stage';

    return {
      version,
      environment,
      pilot: (pilotCol && row[pilotCol]?.trim()) || undefined,
      date,
      pageUrl: this.opts.rosterPageUrl,
    };
  }

  async fetchDesiredConfig(version: string, environment: Environment): Promise<DesiredConfigVar[]> {
    const pageId = await this.findReleasePageId(version);
    if (!pageId) {
      throw new Error(`Could not find a Confluence release page for "${version}".`);
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
