import * as vscode from 'vscode';
import { ConfluenceAuthService } from './confluenceAuthService';

export interface ConfluencePageDetail {
  id: string;
  title: string;
  url: string;
  text: string;
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

/**
 * Read ONE Confluence page by id or URL, live from Confluence — same OAuth
 * session as the synced docs index, but always current (the index may be
 * stale). Mirrors `ConfluenceReleaseSource`'s direct-fetch pattern
 * (`services/deployment/confluenceReleaseSource.ts`), which reuses this same
 * `pageIdFromUrl`.
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

  const auth = new ConfluenceAuthService(context);
  const site = auth.getStoredSite();
  if (!site) {
    throw new Error('No Confluence site connected — connect Confluence in Settings first.');
  }
  const token = await auth.getValidAccessToken();

  const url = `https://api.atlassian.com/ex/confluence/${site.id}/wiki/api/v2/pages/${pageId}?body-format=storage`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Confluence page ${pageId} not found (or you don't have access to it).`);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`Confluence page ${pageId} fetch failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data: any = await res.json();
  const html: string = data?.body?.storage?.value ?? '';
  let webui: string = data?._links?.webui ?? '';
  if (webui && !webui.startsWith('/')) webui = '/' + webui;

  return {
    id: pageId,
    title: data?.title ?? '',
    url: `${site.url.replace(/\/$/, '')}/wiki${webui}`,
    text: stripStorageHtml(html),
  };
}
