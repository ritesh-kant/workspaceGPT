import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { AdoAuthService } from './adoAuthService';

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

export interface TicketComment {
  author: string;
  date?: string;
  text: string;
}

export interface TicketDetail {
  id: number;
  title: string;
  type: string;
  state: string;
  assignedTo?: string;
  sprint?: string;
  area?: string;
  tags?: string[];
  priority?: number;
  createdDate?: string;
  changedDate?: string;
  url: string;
  description?: string;
  acceptanceCriteria?: string;
  /** Parent work item (epic/feature) when the item is part of a hierarchy. */
  parentId?: number;
  /** Only populated when `includeComments` was requested. */
  comments?: TicketComment[];
}

interface AdoRequestContext {
  authHeader: string;
  orgName: string;
  projectName: string;
}

/**
 * Ticket ID as users write it → the numeric ID the ADO API needs.
 *
 * Prefixes like `TKT-`, `D2C-` or a leading `#` are *organisation conventions*,
 * not part of Azure DevOps: work items are plain integers. So rather than
 * knowing any org's prefix (which would put an org string in the engine — see
 * NORTH-STAR.md), take the trailing digit run and ignore whatever precedes it.
 */
export function parseWorkItemId(raw: string): number {
  const match = String(raw ?? '').trim().match(/(\d+)\s*$/);
  if (!match) {
    throw new Error(
      `"${raw}" doesn't contain a work-item number. Azure DevOps work items are numeric ` +
        '(any prefix like "TKT-" is just a local convention) — pass e.g. "1234" or "TKT-1234". ' +
        'To find an item by description instead, use search_tickets.'
    );
  }
  return Number(match[1]);
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

/** Comments are supplementary — never fail the whole read because they 404'd. */
async function fetchComments(ctx: AdoRequestContext, id: number): Promise<TicketComment[]> {
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
  const parentId = parentRelation?.url
    ? Number(String(parentRelation.url).split('/').pop())
    : undefined;

  const tags = String(f['System.Tags'] ?? '')
    .split(';')
    .map((t: string) => t.trim())
    .filter(Boolean);

  return {
    id: item.id ?? id,
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
    description: f['System.Description'] ? htmlToText(f['System.Description']) : undefined,
    acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria']
      ? htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria'])
      : undefined,
    parentId: Number.isFinite(parentId) ? parentId : undefined,
    ...(args?.includeComments ? { comments: await fetchComments(ctx, id) } : {}),
  };
}

// ── "Your work": the tickets assigned to the signed-in user ──────────────────

export interface WorkItemSummary {
  id: number;
  title: string;
  type: string;
  state: string;
  /** Full iteration path, e.g. `MyProject\\Sprint 24`. */
  sprint?: string;
  url: string;
  changedDate?: string;
  /** True when this item sits in (or under) the team's current sprint. */
  inCurrentSprint: boolean;
}

export interface MyWorkItemsResult {
  items: WorkItemSummary[];
  /** Display name of the current sprint, when one could be detected. */
  currentSprintName?: string;
  /** ISO timestamp of the fetch that produced these items. */
  fetchedAt: string;
}

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
  rank: Map<number, number>
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
  // ranked the ids by recency, so re-impose that order.
  const rank = new Map(ids.map((id, i) => [id, i]));
  const sprintPath: string | undefined = currentSprint?.iterationPath;

  const mapped: WorkItemSummary[] = (batch.value ?? []).map((item: any): WorkItemSummary => {
    const f = item.fields ?? {};
    const iteration: string | undefined = f['System.IterationPath'];
    return {
      id: item.id,
      title: f['System.Title'] ?? '(untitled)',
      type: f['System.WorkItemType'] ?? 'Work Item',
      state: f['System.State'] ?? 'Unknown',
      sprint: iteration,
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
