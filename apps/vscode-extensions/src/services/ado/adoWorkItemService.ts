import * as vscode from 'vscode';
import { ATTACHMENT_LIMITS, STORAGE_KEYS } from '../../../constants';
import { AdoAuthService } from './adoAuthService';
import { MyTicketsResult, TicketAttachmentContent, TicketComment, TicketDetail, TicketImage, TicketRelation, TicketSummary, TicketTextAttachment } from '../tickets/types';
import { MAX_REQUESTED_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENTS, MAX_TEXT_ATTACHMENT_BYTES, condenseAttachmentText, isTextAttachmentName, requestedAttachmentContent, skippedAttachmentsOf } from '../tickets/attachmentText';
import { sniffImageMime } from '../tickets/imageSniff';

/**
 * Live, by-ID work-item reads for the agent loop.
 *
 * This is deliberately separate from the sync path (`adoWorker.ts`, which bulk-
 * fetches items into the embedding index) and from `search_tickets` (semantic
 * search over that index). Semantic search is the wrong tool for an exact ID:
 * the vector for `1234` sits next to `1235`, the index only covers the
 * `lookbackMonths` window, and it is only as fresh as the last sync — so a
 * ticket assigned this morning may not be there at all. When the model has an
 * ID in hand it should read the real thing.
 */

// TicketComment/TicketImage/TicketDetail moved to ../tickets/types.ts (they were
// never ADO-specific in shape) — re-exported here so every existing
// `from '../ado/adoWorkItemService'` import keeps working unchanged. See
// docs/design/jira.md §4.
export type { TicketComment, TicketImage, TicketDetail };

interface AdoRequestContext {
  authHeader: string;
  orgName: string;
  projectName: string;
}

/**
 * Ticket ID as users write it → the canonical ID Azure DevOps needs, as a
 * string. ("Canonical" here is still a plain digit run — ADO ids are
 * genuinely numeric — but returning a string rather than a `number` keeps this
 * function's signature identical in shape to a future provider's, e.g. a Jira
 * `parseId` that returns "PROJ-123" unchanged; see docs/design/jira.md
 * §3.)
 *
 * Prefixes like `TKT-`, `D2C-` or a leading `#` are *organisation conventions*,
 * not part of Azure DevOps: work items are plain integers. So rather than
 * knowing any org's prefix (which would put an org string in the engine — see
 * docs/north-star.md), take the trailing digit run and ignore whatever precedes it.
 */
export function parseWorkItemId(raw: string): string {
  const match = String(raw ?? '').trim().match(/(\d+)\s*$/);
  if (!match) {
    throw new Error(
      `"${raw}" doesn't contain a work-item number. Azure DevOps work items are numeric ` +
        '(any prefix like "TKT-" is just a local convention) — pass e.g. "1234" or "TKT-1234". ' +
        'To find an item by description instead, use search_tickets.'
    );
  }
  return match[1];
}

/**
 * ADO stores rich-text fields as HTML. Tags are converted to their plain-text
 * equivalent rather than simply deleted: acceptance criteria are almost always
 * a bulleted list, and stripping `<li>` outright would run every criterion
 * into one unreadable line — losing exactly the structure the model needs to
 * satisfy them one by one.
 */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    // `<li>` already opened the line — closing it must not add a second break,
    // or every bullet list comes out double-spaced.
    .replace(/<\/li>/gi, '')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** Auth header + org/project, or a message telling the user how to fix it. */
async function getRequestContext(context: vscode.ExtensionContext): Promise<AdoRequestContext> {
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  const orgName = settings?.state?.config?.ado?.orgName;
  const projectName = settings?.state?.config?.ado?.projectName;
  if (!orgName || !projectName) {
    throw new Error(
      'Azure DevOps is not configured (missing organisation/project). Connect it in Settings → Azure DevOps.'
    );
  }
  const authHeader = await new AdoAuthService(context).getValidAuthHeader();
  return { authHeader, orgName, projectName };
}

async function adoGet(ctx: AdoRequestContext, url: string, what: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: ctx.authHeader, Accept: 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `No work item ${what} in project "${ctx.projectName}". Check the ID, or use search_tickets to find it by description.`
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Azure DevOps rejected the request — the access token may be expired or missing the ' +
          '"Work Items (Read)" scope. Reconnect Azure DevOps in Settings.'
      );
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Azure DevOps request failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return response.json();
}

const MAX_TICKET_IMAGES = 5;

/**
 * `<img src="...">` URLs from a ticket's raw HTML description, run *before*
 * `htmlToText` strips tags (which would otherwise discard them). Only ADO's
 * own attachment hosts are kept — a description could contain an `<img>`
 * pointing anywhere, and blindly fetching it would leak the org's auth header
 * to a third-party host.
 */
function extractImageUrls(html: string, ctx: AdoRequestContext): string[] {
  const urls = new Set<string>();
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    try {
      const u = new URL(match[1], `https://dev.azure.com/${ctx.orgName}/`);
      if (u.hostname === 'dev.azure.com' || u.hostname.endsWith('.visualstudio.com')) {
        urls.add(u.toString());
      }
    } catch {
      // unparseable src — skip it
    }
  }
  return [...urls].slice(0, MAX_TICKET_IMAGES);
}

/** Download + base64-encode each image. A single bad image never fails the ticket read. */
async function fetchTicketImages(ctx: AdoRequestContext, urls: string[]): Promise<TicketImage[]> {
  const images: TicketImage[] = [];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: { Authorization: ctx.authHeader } });
      if (!resp.ok) continue;
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > ATTACHMENT_LIMITS.MAX_IMAGE_BYTES) continue;
      // Skip anything that isn't recognizably an image: an auth redirect or an
      // error page would otherwise be base64'd and sent as if it were one,
      // failing the whole request rather than just this attachment.
      const mimeType = sniffImageMime(buf);
      if (!mimeType) continue;
      const dataUrl = `data:${mimeType};base64,${Buffer.from(buf).toString('base64')}`;
      const name = decodeURIComponent(url.split('/').pop() || `image-${images.length}.png`);
      images.push({ name, mimeType, dataUrl });
    } catch {
      // network/decoding failure — skip this image only
    }
  }
  return images;
}


/** ADO link types → the name a person would use. */
const ADO_LINK_NAMES: Record<string, string> = {
  'System.LinkTypes.Related': 'Related',
  'System.LinkTypes.Duplicate-Forward': 'Duplicate',
  'System.LinkTypes.Duplicate-Reverse': 'Duplicate',
  'System.LinkTypes.Hierarchy-Forward': 'Child',
  'System.LinkTypes.Hierarchy-Reverse': 'Parent',
  'System.LinkTypes.Dependency-Forward': 'Successor',
  'System.LinkTypes.Dependency-Reverse': 'Predecessor',
};

/**
 * What a ticket is linked to — for a bug, a duplicate or an earlier bug with
 * the same signature, and the commits / PRs / branches already attached to it.
 * Work-item links name an id; artifact links (vstfs:///…) name a commit, PR or
 * build by the last segment of their url.
 */
export function relationsOf(item: any, selfId: string): TicketRelation[] {
  const out: TicketRelation[] = [];
  for (const r of item?.relations ?? []) {
    const rel = String(r?.rel ?? '');
    const url = String(r?.url ?? '');
    if (rel === 'AttachedFile' || rel === 'Hyperlink' || !url) continue;
    if (rel === 'ArtifactLink') {
      const last = decodeURIComponent(url.split('/').pop() ?? '').split('/').pop() ?? '';
      if (last) out.push({ rel: String(r?.attributes?.name ?? 'Linked artifact'), id: last.length === 40 ? last.slice(0, 8) : last });
      continue;
    }
    const name = ADO_LINK_NAMES[rel];
    const id = url.split('/').pop() ?? '';
    if (name && /^\d+$/.test(id) && id !== selfId) out.push({ rel: name, id });
  }
  return out;
}

/** Plain-text attachments (logs, traces). A bad or oversized one is skipped; it never fails the ticket read. */
async function fetchTextAttachments(ctx: AdoRequestContext, item: any): Promise<TicketTextAttachment[]> {
  const out: TicketTextAttachment[] = [];
  for (const r of item?.relations ?? []) {
    if (out.length >= MAX_TEXT_ATTACHMENTS) break;
    if (r?.rel !== 'AttachedFile') continue;
    const name = String(r?.attributes?.name ?? '');
    const size = Number(r?.attributes?.resourceSize ?? 0);
    if (!isTextAttachmentName(name) || (size && size > MAX_TEXT_ATTACHMENT_BYTES)) continue;
    try {
      const u = new URL(String(r.url));
      // Only ADO's own hosts: this request carries the org's auth header.
      if (u.hostname !== 'dev.azure.com' && !u.hostname.endsWith('.visualstudio.com')) continue;
      const resp = await fetch(u.toString(), { headers: { Authorization: ctx.authHeader } });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.includes('\u0000')) continue; // binary dressed as text
      out.push({ name, text: condenseAttachmentText(text) });
    } catch {
      // network failure — skip this attachment only
    }
  }
  return out;
}

/** Every file attached to the work item, as name + size. */
function attachedFilesOf(item: any): { name: string; sizeBytes?: number }[] {
  return (item?.relations ?? [])
    .filter((r: any) => r?.rel === 'AttachedFile')
    .map((r: any) => ({ name: String(r?.attributes?.name ?? ''), sizeBytes: Number(r?.attributes?.resourceSize ?? 0) || undefined }));
}

/**
 * One attached file, read because the user agreed to it. Unlike the automatic
 * read this has no extension or small-size gate (a HAR is tens of MB), but it
 * still only talks to ADO's own hosts and still caps the download.
 */
export async function fetchWorkItemAttachment(
  context: vscode.ExtensionContext,
  args: { id: string | number; name: string }
): Promise<TicketAttachmentContent> {
  const id = parseWorkItemId(String(args?.id ?? ''));
  const ctx = await getRequestContext(context);
  const item = await adoGet(
    ctx,
    `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`,
    `#${id}`
  );
  const want = String(args?.name ?? '').trim().toLowerCase();
  const rel = (item.relations ?? []).find(
    (r: any) => r?.rel === 'AttachedFile' && String(r?.attributes?.name ?? '').toLowerCase() === want
  );
  const name = String(rel?.attributes?.name ?? args?.name ?? '');
  if (!rel) {
    const names = attachedFilesOf(item).map((a) => a.name).join(', ');
    return { name, note: `No attachment named "${args?.name}" on #${id}. Attached: ${names || 'none'}.` };
  }
  const size = Number(rel.attributes?.resourceSize ?? 0);
  if (size > MAX_REQUESTED_ATTACHMENT_BYTES) return { name, note: `Too large to download (${Math.round(size / 1048576)} MB).` };
  const u = new URL(String(rel.url));
  if (u.hostname !== 'dev.azure.com' && !u.hostname.endsWith('.visualstudio.com')) {
    return { name, note: 'This attachment is not hosted by Azure DevOps, so it was not downloaded.' };
  }
  const resp = await fetch(u.toString(), { headers: { Authorization: ctx.authHeader } });
  if (!resp.ok) return { name, note: `Download failed (${resp.status}).` };
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > MAX_REQUESTED_ATTACHMENT_BYTES) return { name, note: 'Too large to download.' };
  const mimeType = sniffImageMime(buf);
  if (mimeType) return { name, images: [{ name, mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(buf).toString('base64')}` }] };
  return requestedAttachmentContent(name, buf);
}

/** Comments are supplementary — never fail the whole read because they 404'd. */
async function fetchComments(ctx: AdoRequestContext, id: string): Promise<TicketComment[]> {
  try {
    const url =
      `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}` +
      `/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`;
    const data = await adoGet(ctx, url, `#${id} comments`);
    return (data.comments ?? []).map((c: any) => ({
      author: c.createdBy?.displayName || 'Unknown',
      date: c.createdDate,
      text: htmlToText(c.text || ''),
    }));
  } catch (error) {
    console.warn(`Could not fetch comments for work item ${id}:`, error);
    return [];
  }
}

/**
 * Read one work item by ID, straight from Azure DevOps.
 *
 * Comments are opt-in: they often carry the requirement that never made it
 * into the description, but they are also the bulk of the tokens, so the model
 * asks for them only when the description alone is thin.
 */
export async function fetchWorkItem(
  context: vscode.ExtensionContext,
  args: { id: string | number; includeComments?: boolean }
): Promise<TicketDetail> {
  const id = parseWorkItemId(String(args?.id ?? ''));
  const ctx = await getRequestContext(context);

  const url =
    `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}` +
    `/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`;
  const item = await adoGet(ctx, url, `#${id}`);
  const f = item.fields ?? {};

  // Hierarchy-Reverse is the link type ADO uses for "my parent"; the parent's
  // id is the last segment of the related item's API url.
  const parentRelation = (item.relations ?? []).find(
    (r: any) => r?.rel === 'System.LinkTypes.Hierarchy-Reverse'
  );
  const parentId = parentRelation?.url ? String(parentRelation.url).split('/').pop() : undefined;

  const tags = String(f['System.Tags'] ?? '')
    .split(';')
    .map((t: string) => t.trim())
    .filter(Boolean);

  const rawDescription = f['System.Description'];
  const imageUrls = rawDescription ? extractImageUrls(rawDescription, ctx) : [];
  const images = imageUrls.length ? await fetchTicketImages(ctx, imageUrls) : [];
  // A bug's own repro steps and environment live in fields that were never read.
  const reproHtml = f['Microsoft.VSTS.TCM.ReproSteps'];
  const systemInfoHtml = f['Microsoft.VSTS.TCM.SystemInfo'];
  const relations = relationsOf(item, id);
  const attachments = await fetchTextAttachments(ctx, item);
  const skippedAttachments = skippedAttachmentsOf(attachedFilesOf(item), attachments.map((a) => a.name));

  return {
    id: item.id != null ? String(item.id) : id,
    title: f['System.Title'] ?? '(untitled)',
    type: f['System.WorkItemType'] ?? 'Work Item',
    state: f['System.State'] ?? 'Unknown',
    assignedTo: f['System.AssignedTo']?.displayName,
    sprint: f['System.IterationPath'],
    area: f['System.AreaPath'],
    tags: tags.length ? tags : undefined,
    priority: f['Microsoft.VSTS.Common.Priority'],
    createdDate: f['System.CreatedDate'],
    changedDate: f['System.ChangedDate'],
    url:
      item._links?.html?.href ||
      `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}/_workitems/edit/${id}`,
    description: rawDescription ? htmlToText(rawDescription) : undefined,
    acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria']
      ? htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria'])
      : undefined,
    parentId: parentId || undefined,
    images: images.length ? images : undefined,
    reproSteps: reproHtml ? htmlToText(reproHtml).trim() || undefined : undefined,
    systemInfo: systemInfoHtml ? htmlToText(systemInfoHtml).trim() || undefined : undefined,
    relations: relations.length ? relations : undefined,
    attachments: attachments.length ? attachments : undefined,
    skippedAttachments: skippedAttachments.length ? skippedAttachments : undefined,
    ...(args?.includeComments ? { comments: await fetchComments(ctx, id) } : {}),
  };
}

// ── "Your work": the tickets assigned to the signed-in user ──────────────────

// TicketSummary/MyTicketsResult moved to ../tickets/types.ts; kept here under
// their original names (ADO calls a ticket a "work item") so every existing
// import of WorkItemSummary/MyWorkItemsResult keeps working unchanged.
export type WorkItemSummary = TicketSummary;
export type MyWorkItemsResult = MyTicketsResult;

/**
 * Terminal states, excluded from "your work".
 *
 * State names are defined by the project's process template, not by ADO —
 * Agile ends at `Closed`, Scrum at `Done`/`Removed`, CMMI at `Closed`. There is
 * no portable "is finished" predicate in WIQL, so we exclude the union of the
 * common terminal names. An unusual custom template may leak a finished item
 * into the list; that is a better failure than hiding open work.
 */
const TERMINAL_STATES = ['Closed', 'Removed', 'Done', 'Completed', 'Resolved'];

/** Cap on the WIQL result set — the panel shows a handful; this is the pool. */
const MY_WORK_ITEMS_LIMIT = 50;

/**
 * The sprint's own display name out of an ADO iteration path.
 *
 * Paths are project-rooted and can nest (`D2C\\Release 1\\Sprint 24`), so the
 * leaf is the sprint the item is actually in. A single-segment path is the
 * project root — the item is in no sprint at all — and returns undefined
 * rather than labelling the row with the project name.
 *
 * This used to be computed in the webview (MyWorkPanel.tsx's sprintLabel),
 * which meant TicketSummary.sprint carried a raw ADO path the UI had to know
 * how to parse — a leaked ADO assumption a Jira provider couldn't honour: a
 * Jira sprint is a bare name with no path to parse, and the old function's
 * "one segment means no sprint" rule would have swallowed every real Jira
 * sprint name (docs/design/jira.md §5 P6, discovered during that
 * phase). Resolving it here means TicketSummary.sprint is always
 * already-a-display-name, whichever provider set it.
 */
function sprintDisplayName(iterationPath?: string): string | undefined {
  const segments = String(iterationPath ?? '')
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : undefined;
}

/**
 * Is `iterationPath` the current sprint, or a sub-iteration of it?
 *
 * Plain `startsWith` is wrong here: with a current sprint of `Proj\\Sprint 2`,
 * it would also claim `Proj\\Sprint 20` is the current sprint. A path is only a
 * descendant if the next character is the ADO path separator.
 */
export function isInCurrentSprint(iterationPath?: string, sprintPath?: string): boolean {
  if (!iterationPath || !sprintPath) return false;
  if (iterationPath === sprintPath) return true;
  return iterationPath.startsWith(`${sprintPath}\\`);
}

/**
 * Current-sprint items first, and within each group the order ADO already
 * ranked them in (most recently changed first) — `workitemsbatch` does not
 * preserve the order of the ids it was given.
 */
export function orderWorkItems(
  items: WorkItemSummary[],
  rank: Map<string, number>
): WorkItemSummary[] {
  return [...items].sort((a, b) => {
    if (a.inCurrentSprint !== b.inCurrentSprint) return a.inCurrentSprint ? -1 : 1;
    return (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0);
  });
}

async function adoPost(ctx: AdoRequestContext, url: string, body: unknown, what: string): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: ctx.authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        'Azure DevOps rejected the request — the access token may be expired or missing the ' +
          '"Work Items (Read)" scope. Reconnect Azure DevOps in Settings.'
      );
    }
    const text = await response.text().catch(() => '');
    throw new Error(`Could not ${what} (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

/** Post an HTML comment on a work item (the agent's run report, after "Create PR"). */
export async function addWorkItemComment(context: vscode.ExtensionContext, id: string, html: string): Promise<void> {
  const ctx = await getRequestContext(context);
  const url =
    `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}` +
    `/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`;
  await adoPost(ctx, url, { text: html }, `comment on work item #${id}`);
}

/**
 * The work items assigned to whoever the stored token belongs to, most recently
 * changed first.
 *
 * Sprint handling is deliberately **not** a WIQL filter. Both options there are
 * brittle: the `@currentIteration` macro needs a team context we may not have,
 * and matching the stored `iterationPath` literally depends on a path format
 * that varies. Either one fails by returning *nothing*, which the UI would show
 * as "you have no work" — the worst possible lie. So we fetch all open assigned
 * items and mark which are in the current sprint client-side: the list is never
 * empty for a formatting reason, and the user still sees their other work.
 */
export async function listMyWorkItems(
  context: vscode.ExtensionContext
): Promise<MyWorkItemsResult> {
  const ctx = await getRequestContext(context);
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  const currentSprint = settings?.state?.config?.ado?.currentSprint ?? null;

  const base = `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}/_apis`;

  // `@Me` is resolved server-side from the token — no need to interpolate the
  // stored display name, which would also open a WIQL-injection seam.
  const excluded = TERMINAL_STATES.map((state) => `'${state}'`).join(', ');
  const wiql = {
    query:
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.TeamProject] = @project ` +
      `AND [System.AssignedTo] = @Me ` +
      `AND [System.State] NOT IN (${excluded}) ` +
      `ORDER BY [System.ChangedDate] DESC`,
  };

  const queryResult = await adoPost(
    ctx,
    `${base}/wit/wiql?api-version=7.1&$top=${MY_WORK_ITEMS_LIMIT}`,
    wiql,
    'query your Azure DevOps work items'
  );

  const ids: number[] = (queryResult.workItems ?? []).map((w: any) => w.id).filter(Boolean);
  if (!ids.length) {
    return {
      items: [],
      currentSprintName: currentSprint?.name,
      fetchedAt: new Date().toISOString(),
    };
  }

  const batch = await adoPost(
    ctx,
    `${base}/wit/workitemsbatch?api-version=7.1`,
    {
      ids,
      fields: [
        'System.Id',
        'System.Title',
        'System.WorkItemType',
        'System.State',
        'System.IterationPath',
        'System.ChangedDate',
      ],
    },
    'read your Azure DevOps work items'
  );

  // workitemsbatch does not guarantee the order we asked for; WIQL already
  // ranked the ids by recency, so re-impose that order. Keyed by the string
  // form since that is what WorkItemSummary.id (and orderWorkItems' rank
  // lookup) use.
  const rank = new Map(ids.map((id, i) => [String(id), i]));
  const sprintPath: string | undefined = currentSprint?.iterationPath;

  const mapped: WorkItemSummary[] = (batch.value ?? []).map((item: any): WorkItemSummary => {
    const f = item.fields ?? {};
    const iteration: string | undefined = f['System.IterationPath'];
    return {
      id: String(item.id),
      title: f['System.Title'] ?? '(untitled)',
      type: f['System.WorkItemType'] ?? 'Work Item',
      state: f['System.State'] ?? 'Unknown',
      sprint: sprintDisplayName(iteration),
      changedDate: f['System.ChangedDate'],
      url: `https://dev.azure.com/${encodeURIComponent(ctx.orgName)}/${encodeURIComponent(ctx.projectName)}/_workitems/edit/${item.id}`,
      inCurrentSprint: isInCurrentSprint(iteration, sprintPath),
    };
  });
  const items = orderWorkItems(mapped, rank);

  return {
    items,
    currentSprintName: currentSprint?.name,
    fetchedAt: new Date().toISOString(),
  };
}
