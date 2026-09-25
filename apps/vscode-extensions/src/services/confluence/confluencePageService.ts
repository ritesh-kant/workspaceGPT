import * as vscode from 'vscode';
import { ConfluenceAuthService, ConfluenceSite } from './confluenceAuthService';
import { AdfDoc, adfToMarkdown, editPage, EditMode, markdownToAdf } from './confluenceAdf';

export interface ConfluencePageDetail {
  id: string;
  title: string;
  url: string;
  /** The body as markdown — headings, lists, tables and code intact; see confluenceAdf.ts. */
  text: string;
  /** Current version number — an edit is written against it (a newer one means someone else edited). */
  version?: number;
  spaceId?: string;
  parentId?: string;
  /** Headings update_confluence_page can target, exactly as it accepts them. */
  sections?: string[];
  note?: string;
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
 * Strip storage-format tags to plain text, preserving digits (dates, versions,
 * ticket numbers) — unlike the RAG index's text extractor (`extractTextFromXML`
 * in `@workspace-gpt/confluence-utils`), which deliberately discards isolated
 * numbers because they're noise for embeddings. A page read directly for the
 * model/user to reason over needs those numbers intact.
 */
function stripStorageHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** OAuth scope a page edit or create needs. Connections made before it was requested are read-only. */
export const CONFLUENCE_WRITE_SCOPE = 'write:page:confluence';

interface ConfluenceApi {
  site: ConfluenceSite;
  call<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

/** One authenticated Confluence v2 API client for this call — same OAuth session as the docs index. */
async function confluenceApi(context: vscode.ExtensionContext): Promise<ConfluenceApi> {
  const auth = new ConfluenceAuthService(context);
  const site = auth.getStoredSite();
  if (!site) {
    throw new Error('No Confluence site connected — connect Confluence in Settings first.');
  }
  await auth.getValidAccessToken(); // fail fast when the session is gone
  const base = `https://api.atlassian.com/ex/confluence/${site.id}/wiki/api/v2`;
  return {
    site,
    async call(path, init) {
      // Per call, not per client: a write is applied after the user approves
      // its card, which can be long after it was prepared (tokens last ~1h).
      const token = await auth.getValidAccessToken();
      const res = await fetch(`${base}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      if (res.ok) return (res.status === 204 ? null : res.json()) as any;
      const body = await res.text().catch(() => '');
      const err = new Error(`Confluence ${init?.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status}): ${body.slice(0, 300)}`);
      (err as any).status = res.status;
      throw err;
    },
  };
}

function webUrl(site: ConfluenceSite, links: any): string {
  let webui: string = links?.webui ?? '';
  if (webui && !webui.startsWith('/')) webui = '/' + webui;
  return webui ? `${site.url.replace(/\/$/, '')}/wiki${webui}` : '';
}

async function readPage(api: ConfluenceApi, pageId: string): Promise<{ data: any; doc: AdfDoc | null }> {
  let data: any;
  try {
    data = await api.call(`/pages/${pageId}?body-format=atlas_doc_format`);
  } catch (e: any) {
    if (e?.status === 404) throw new Error(`Confluence page ${pageId} not found (or you don't have access to it).`);
    throw e;
  }
  const raw = data?.body?.atlas_doc_format?.value;
  let doc: AdfDoc | null = null;
  try {
    doc = typeof raw === 'string' && raw ? JSON.parse(raw) : raw && typeof raw === 'object' ? raw : null;
  } catch {
    doc = null;
  }
  return { data, doc };
}

const KEEP_NOTE =
  '⟦keep N: …⟧ tokens stand for Confluence elements markdown cannot show (macros, mentions, images, status labels, complex tables). ' +
  'To edit around one, copy the token exactly — that element is preserved as-is. Leaving a token out removes that element.';

/**
 * Read ONE Confluence page by id or URL, live from Confluence — same OAuth
 * session as the synced docs index, but always current (the index may be
 * stale). The body comes back as markdown rendered from the page's ADF, so
 * tables, headings and lists survive — the old storage-HTML strip flattened
 * them into one run of text. Mirrors `ConfluenceReleaseSource`'s direct-fetch
 * pattern (`services/deployment/confluenceReleaseSource.ts`), which reuses
 * this same `pageIdFromUrl`.
 */
export async function fetchConfluencePage(
  context: vscode.ExtensionContext,
  pageIdOrUrl: string
): Promise<ConfluencePageDetail> {
  const pageId = pageIdFromUrl(pageIdOrUrl);
  if (!pageId) {
    throw new Error(
      `Could not read a Confluence page id from "${pageIdOrUrl}" — pass the numeric page id or a full page URL.`
    );
  }
  const api = await confluenceApi(context);
  const { data, doc } = await readPage(api, pageId);

  let text: string;
  let sections: string[] | undefined;
  let hasKeep = false;
  if (doc) {
    const rendered = adfToMarkdown(doc);
    text = rendered.markdown;
    sections = rendered.sections;
    hasKeep = rendered.keep.size > 0;
  } else {
    // No ADF body on this page — fall back to the storage format as plain text.
    const storage: any = await api.call(`/pages/${pageId}?body-format=storage`);
    text = stripStorageHtml(storage?.body?.storage?.value ?? '');
  }

  return {
    id: pageId,
    title: data?.title ?? '',
    url: webUrl(api.site, data?._links),
    text,
    version: data?.version?.number,
    spaceId: data?.spaceId,
    parentId: data?.parentId ?? undefined,
    sections,
    ...(hasKeep ? { note: KEEP_NOTE } : {}),
  };
}

// ─────────────────────────── writes ───────────────────────────

/**
 * A Confluence write prepared for review: everything the approval card shows
 * and everything the apply step sends, computed BEFORE the user decides so
 * the card is exactly what will be written.
 */
export interface PreparedConfluenceWrite {
  kind: 'confluence-edit' | 'confluence-create';
  /** Where it lands, for the card header: "D2C › Parent › Title". */
  location: string;
  summary: string;
  before: string;
  after: string;
  /** Page to open from the card (the page itself, or the parent for a create). */
  url: string;
  apply: () => Promise<{ applied: true; id: string; title: string; url: string; version?: number; status?: string }>;
}

function requireWriteScope(site: ConfluenceSite): void {
  if (!(site.scopes ?? []).includes(CONFLUENCE_WRITE_SCOPE)) {
    throw new Error(
      'Confluence is connected read-only — this connection was made before WorkspaceGPT could edit pages. ' +
        'Tell the user to reconnect Confluence in Settings → Knowledge to allow editing and creating pages, then retry. ' +
        'Until then, give them the proposed text in your answer instead.'
    );
  }
}

const conflictError = (pageId: string, version: number) =>
  new Error(
    `Confluence page ${pageId} changed since it was read (you edited version ${version}; someone saved a newer one). ` +
      'Read it again with get_confluence_page and redo the edit against the current content.'
  );

/** Edit one section of a page (or append / replace it whole), leaving every other node untouched. */
export async function prepareConfluenceEdit(
  context: vscode.ExtensionContext,
  args: { pageId?: string; mode?: EditMode; section?: string; markdown?: string; versionMessage?: string }
): Promise<PreparedConfluenceWrite> {
  const pageId = pageIdFromUrl(String(args?.pageId ?? ''));
  if (!pageId) throw new Error('pageId must be a Confluence page id or URL.');
  if (typeof args?.markdown !== 'string') throw new Error('markdown is required — the new content to write.');
  const mode: EditMode = args.mode ?? (args.section ? 'replace_section' : 'append');

  const api = await confluenceApi(context);
  requireWriteScope(api.site);
  const { data, doc } = await readPage(api, pageId);
  if (!doc) throw new Error(`Confluence page ${pageId} has no editable (ADF) body.`);
  const version = Number(data?.version?.number ?? 0);
  const title: string = data?.title ?? '';

  const edit = editPage(doc, { mode, section: args.section, markdown: args.markdown });
  if (edit.before === edit.after && mode === 'replace_section') {
    throw new Error('That edit changes nothing on the page — the new section is identical to the current one.');
  }
  const where = mode === 'replace_page' ? 'whole page' : mode === 'append' ? 'end of page' : String(args.section);
  const url = webUrl(api.site, data?._links);

  return {
    kind: 'confluence-edit',
    location: `${title} · ${where}`,
    summary: `Edit Confluence page "${title}" (${where})`,
    before: edit.before,
    after: edit.after,
    url,
    apply: async () => {
      try {
        const saved: any = await api.call(`/pages/${pageId}`, {
          method: 'PUT',
          body: {
            id: pageId,
            status: 'current',
            title,
            body: { representation: 'atlas_doc_format', value: JSON.stringify(edit.doc) },
            version: { number: version + 1, message: (args.versionMessage ?? 'Edited with WorkspaceGPT').slice(0, 250) },
          },
        });
        return { applied: true, id: pageId, title, url: webUrl(api.site, saved?._links) || url, version: saved?.version?.number };
      } catch (e: any) {
        if (e?.status === 409) throw conflictError(pageId, version);
        if (e?.status === 403) throw new Error(`Confluence refused the edit (403) — the user may not have edit permission on "${title}".`);
        throw e;
      }
    },
  };
}

/** Resolve where a new page goes: under `parentId`, or at the top of `spaceKey`. */
async function resolveLocation(
  api: ConfluenceApi,
  args: { spaceKey?: string; parentId?: string }
): Promise<{ spaceId: string; spaceKey: string; parentId?: string; parentTitle?: string; parentUrl?: string }> {
  const parentId = args.parentId ? pageIdFromUrl(String(args.parentId)) : null;
  if (args.parentId && !parentId) throw new Error(`parentId "${args.parentId}" is not a Confluence page id or URL.`);
  if (parentId) {
    const { data } = await readPage(api, parentId);
    const space: any = await api.call(`/spaces/${data.spaceId}`);
    return { spaceId: String(data.spaceId), spaceKey: space?.key ?? '', parentId, parentTitle: data.title, parentUrl: webUrl(api.site, data._links) };
  }
  const key = String(args.spaceKey ?? '').trim();
  if (!key) {
    throw new Error(
      'No location given. Call find_confluence_location, show the user the suggested spaces/parents, and ask where the page should go ' +
        'before calling create_confluence_page with their choice.'
    );
  }
  const res: any = await api.call(`/spaces?keys=${encodeURIComponent(key)}`);
  const space = res?.results?.[0];
  if (!space) throw new Error(`No Confluence space with key "${key}" (or no access to it). Use find_confluence_location to list spaces.`);
  return { spaceId: String(space.id), spaceKey: space.key };
}

/** A new page from markdown — a draft unless `publish` is set. */
export async function prepareConfluenceCreate(
  context: vscode.ExtensionContext,
  args: { title?: string; markdown?: string; spaceKey?: string; parentId?: string; publish?: boolean }
): Promise<PreparedConfluenceWrite> {
  const title = String(args?.title ?? '').trim();
  if (!title) throw new Error('title is required.');
  if (typeof args?.markdown !== 'string') throw new Error('markdown is required — the page body.');

  const api = await confluenceApi(context);
  requireWriteScope(api.site);
  const loc = await resolveLocation(api, args);

  // Confluence rejects a duplicate title within a space — say so before the user reviews it.
  const existing: any = await api.call(`/pages?space-id=${loc.spaceId}&title=${encodeURIComponent(title)}&limit=1`);
  const dup = existing?.results?.[0];
  if (dup) {
    throw new Error(
      `A page titled "${title}" already exists in ${loc.spaceKey}: ${webUrl(api.site, dup._links)} (id ${dup.id}). ` +
        'Edit that page with update_confluence_page, or choose a different title.'
    );
  }

  const doc = markdownToAdf(args.markdown);
  const status = args.publish ? 'current' : 'draft';
  const location = [loc.spaceKey, loc.parentTitle, title].filter(Boolean).join(' › ');

  return {
    kind: 'confluence-create',
    location: status === 'draft' ? `${location} (draft)` : location,
    summary: `Create Confluence page "${title}" in ${loc.spaceKey}${loc.parentTitle ? ` under "${loc.parentTitle}"` : ''}${status === 'draft' ? ' as a draft' : ''}`,
    before: '',
    after: adfToMarkdown(doc).markdown,
    url: loc.parentUrl ?? '',
    apply: async () => {
      try {
        const created: any = await api.call('/pages', {
          method: 'POST',
          body: {
            spaceId: loc.spaceId,
            status,
            title,
            ...(loc.parentId ? { parentId: loc.parentId } : {}),
            body: { representation: 'atlas_doc_format', value: JSON.stringify(doc) },
          },
        });
        const url = webUrl(api.site, created?._links) || webUrl(api.site, { webui: created?._links?.editui });
        return { applied: true, id: String(created?.id ?? ''), title, url, version: created?.version?.number, status };
      } catch (e: any) {
        if (e?.status === 403) throw new Error(`Confluence refused to create the page (403) — the user may not have permission to add pages in ${loc.spaceKey}.`);
        throw e;
      }
    },
  };
}

// ─────────────────────────── where should a new page go? ───────────────────────────

export interface LocationSuggestion {
  spaceKey: string;
  spaceName: string;
  parentId?: string;
  parentTitle?: string;
  parentUrl?: string;
  because: string;
}

/**
 * Candidate homes for a new page, from FACTS: the parents of the existing
 * pages most similar to it (from the synced index, resolved live), plus the
 * connected space itself. Returned for the model to put to the user — never
 * to pick from silently.
 */
export async function suggestConfluenceLocation(
  context: vscode.ExtensionContext,
  similar: { title?: string; url?: string }[],
  syncedSpaceKey?: string
): Promise<{ suggestions: LocationSuggestion[]; spaces: { key: string; name: string }[]; note: string }> {
  const api = await confluenceApi(context);
  const auth = new ConfluenceAuthService(context);
  const allSpaces = await auth.fetchSpaces(api.site.id).catch(() => []);
  const byId = new Map(allSpaces.map((s) => [String(s.id), s]));

  const parents = new Map<string, { spaceId: string; siblings: string[] }>();
  await Promise.all(
    similar.slice(0, 8).map(async (hit) => {
      const id = pageIdFromUrl(String(hit.url ?? ''));
      if (!id) return;
      try {
        const page: any = await api.call(`/pages/${id}`);
        if (!page?.parentId) return;
        const entry = parents.get(String(page.parentId)) ?? { spaceId: String(page.spaceId), siblings: [] };
        entry.siblings.push(page.title ?? hit.title ?? id);
        parents.set(String(page.parentId), entry);
      } catch {
        /* a hit that no longer resolves is simply not a suggestion */
      }
    })
  );

  const ranked = [...parents.entries()].sort((a, b) => b[1].siblings.length - a[1].siblings.length).slice(0, 4);
  const suggestions: LocationSuggestion[] = [];
  for (const [parentId, { spaceId, siblings }] of ranked) {
    try {
      const parent: any = await api.call(`/pages/${parentId}`);
      const space = byId.get(spaceId);
      suggestions.push({
        spaceKey: space?.key ?? '',
        spaceName: space?.name ?? '',
        parentId,
        parentTitle: parent?.title,
        parentUrl: webUrl(api.site, parent?._links),
        because: `parent of similar page${siblings.length > 1 ? 's' : ''}: ${siblings.slice(0, 3).map((t) => `"${t}"`).join(', ')}`,
      });
    } catch {
      /* skip */
    }
  }
  const synced = syncedSpaceKey ? allSpaces.find((s) => s.key === syncedSpaceKey) : undefined;
  if (synced) suggestions.push({ spaceKey: synced.key, spaceName: synced.name, because: 'top level of the connected space' });

  return {
    suggestions,
    spaces: allSpaces.filter((s) => s.type === 'global').slice(0, 40).map((s) => ({ key: s.key, name: s.name })),
    note:
      'Ask the user where the page should go — offer these suggestions (and any space above) and wait for their choice. ' +
      'Then call create_confluence_page with spaceKey and/or parentId.',
  };
}
