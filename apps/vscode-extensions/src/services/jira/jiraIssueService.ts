import * as vscode from 'vscode';
import { ATTACHMENT_LIMITS } from '../../../constants';
import { JiraAuthService, jiraApiBase } from './jiraAuthService';
import { TicketComment, TicketDetail, TicketImage } from '../tickets/types';
import { adfToText, markdownToAdf, mediaIdsFromAdf } from './adf';
import { sniffImageMime } from '../tickets/imageSniff';

/**
 * Live, by-key issue reads — the Jira half of JIRA-INTEGRATION-DESIGN.md §5
 * P4, mirroring adoWorkItemService.ts's fetchWorkItem/addWorkItemComment.
 *
 * Deliberately separate from a future sync path and from `search_tickets`,
 * for the same reason adoWorkItemService.ts gives: semantic search over a
 * synced index is the wrong tool for an exact key, and the index (once Jira
 * sync exists — design doc P5) is only ever as fresh as its last run.
 */

interface JiraRequestContext {
  authHeader: string;
  /** `https://api.atlassian.com/ex/jira/{cloudId}` — every REST call goes here, not the site's own domain (OAuth-authenticated calls are proxied). */
  apiBase: string;
  /** The site's real domain, e.g. `https://yourcompany.atlassian.net` — for building `/browse/{key}` links only. */
  siteUrl: string;
}

const MAX_TICKET_IMAGES = 5;

async function getRequestContext(context: vscode.ExtensionContext): Promise<JiraRequestContext> {
  const authService = new JiraAuthService(context);
  const site = authService.getStoredSite();
  if (!site) {
    throw new Error('Jira is not connected. Connect it in Settings → Jira.');
  }
  const authHeader = await authService.getValidAuthHeader();
  return { authHeader, apiBase: jiraApiBase(site.id), siteUrl: site.url };
}

async function jiraGet(ctx: JiraRequestContext, url: string, what: string): Promise<any> {
  const response = await fetch(url, { headers: { Authorization: ctx.authHeader, Accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`No Jira issue ${what}. Check the key, or use search_tickets to find it by description.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Jira rejected the request — the connection may have expired or lost permission. Reconnect Jira in Settings.'
      );
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Jira request failed (${response.status}): ${body.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * Issue key as users write it → the canonical key Jira needs.
 *
 * Unlike parseWorkItemId's trailing-digit-run rule, the key IS the id — a
 * Jira key is never truncated to its trailing digits, because "123" alone
 * means nothing in Jira. See JIRA-INTEGRATION-DESIGN.md §3, the reason P0 had
 * to land before any of this file could exist.
 */
export function parseIssueKey(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  const fromUrl = /\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/i.exec(trimmed);
  const bare = /\b([A-Za-z][A-Za-z0-9_]*-\d+)\b/i.exec(trimmed);
  const key = fromUrl?.[1] ?? bare?.[1];
  if (!key) {
    throw new Error(
      `"${raw}" doesn't look like a Jira issue key. Jira issues are "PROJECT-123" — pass e.g. "PROJ-123", or a full issue URL. ` +
        'To find an item by description instead, use search_tickets.'
    );
  }
  return key.toUpperCase();
}

/**
 * Download + base64-encode each inline image, by attachment id.
 *
 * UNVERIFIED against a live Jira instance (design doc §8 risk 2):
 * `/rest/api/3/attachment/content/{id}` is the documented download endpoint
 * for a plain attachment, and an ADF `media` node's id coincides with the
 * attachment id for the ordinary case (an image pasted or uploaded to the
 * issue) — but Jira's media services can route some site configurations
 * through a separate token exchange instead. If this 404s in practice on a
 * real site, this is the first thing to re-check.
 */
async function fetchAttachmentImages(ctx: JiraRequestContext, ids: string[]): Promise<TicketImage[]> {
  const images: TicketImage[] = [];
  for (const id of ids.slice(0, MAX_TICKET_IMAGES)) {
    try {
      const url = `${ctx.apiBase}/rest/api/3/attachment/content/${encodeURIComponent(id)}`;
      const resp = await fetch(url, { headers: { Authorization: ctx.authHeader } });
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > ATTACHMENT_LIMITS.MAX_IMAGE_BYTES) continue;
      // Same reasoning as adoWorkItemService.ts's fetchTicketImages: never
      // trust the HTTP content-type, sniff the bytes instead.
      const mimeType = sniffImageMime(buf);
      if (!mimeType) continue;
      images.push({ name: id, mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(buf).toString('base64')}` });
    } catch {
      // network/decoding failure — skip this image only
    }
  }
  return images;
}

/** Comments are supplementary — never fail the whole read because they errored. */
async function fetchComments(ctx: JiraRequestContext, key: string): Promise<TicketComment[]> {
  try {
    const url = `${ctx.apiBase}/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=50&orderBy=-created`;
    const data = await jiraGet(ctx, url, `#${key} comments`);
    return (data.comments ?? []).map((c: any) => ({
      author: c.author?.displayName || 'Unknown',
      date: c.created,
      text: adfToText(c.body),
    }));
  } catch (error) {
    console.warn(`Could not fetch comments for Jira issue ${key}:`, error);
    return [];
  }
}

const ISSUE_FIELDS = 'summary,issuetype,status,assignee,description,labels,priority,created,updated,parent,project';

/**
 * Read one issue by key, straight from Jira. Comments are opt-in for the same
 * reason as ADO's fetchWorkItem: they carry requirements the description
 * missed, but they are also most of the tokens.
 */
export async function fetchJiraIssue(
  context: vscode.ExtensionContext,
  args: { id: string | number; includeComments?: boolean }
): Promise<TicketDetail> {
  const key = parseIssueKey(String(args?.id ?? ''));
  const ctx = await getRequestContext(context);

  const item = await jiraGet(ctx, `${ctx.apiBase}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`, key);
  const f = item.fields ?? {};

  const description = f.description ? adfToText(f.description) : undefined;
  const mediaIds = f.description ? mediaIdsFromAdf(f.description) : [];
  const images = mediaIds.length ? await fetchAttachmentImages(ctx, mediaIds) : [];

  return {
    id: item.key ?? key,
    title: f.summary ?? '(untitled)',
    type: f.issuetype?.name ?? 'Issue',
    state: f.status?.name ?? 'Unknown',
    assignedTo: f.assignee?.displayName,
    area: f.project?.name,
    tags: f.labels?.length ? f.labels : undefined,
    priority: f.priority?.name,
    createdDate: f.created,
    changedDate: f.updated,
    url: `${ctx.siteUrl}/browse/${item.key ?? key}`,
    description,
    // Jira has no separate "acceptance criteria" field — teams that use one
    // do it as a custom field, whose id varies per site (design doc §8 risk
    // 3). Left undefined rather than guessed; the description already
    // carries whatever the team put there.
    parentId: f.parent?.key,
    images: images.length ? images : undefined,
    ...(args?.includeComments ? { comments: await fetchComments(ctx, key) } : {}),
  };
}

/** Post a comment on an issue (the agent's run report, after "Create PR"). `markdown` is rendered to ADF, mirroring shipHelpers.ts's reportToHtml for ADO. */
export async function addJiraComment(context: vscode.ExtensionContext, key: string, markdown: string): Promise<void> {
  const ctx = await getRequestContext(context);
  const response = await fetch(`${ctx.apiBase}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { Authorization: ctx.authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: markdownToAdf(markdown) }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Jira rejected the request — the connection may have expired or lost permission. Reconnect Jira in Settings.'
      );
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Could not comment on Jira issue ${key} (${response.status}): ${text.slice(0, 200)}`);
  }
}
