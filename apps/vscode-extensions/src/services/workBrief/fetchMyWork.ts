/**
 * The user's OWN items over the last year, from each connected Knowledge
 * source plus pull requests and call notes. Separate from the project syncs
 * (which reach `lookbackDays` across a whole project): this asks each source
 * for "mine" only, so a year stays small.
 *
 * Reads only. Nothing leaves the machine except these requests to the
 * user's own sources; the result is stored on-device by workBrief.ts.
 */
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { STORAGE_KEYS } from '../../../constants';
import { AdoAuthService } from '../ado/adoAuthService';
import { htmlToText } from '../ado/adoWorkItemService';
import { JiraAuthService, jiraApiBase } from '../jira/jiraAuthService';
import { ConfluenceAuthService } from '../confluence/confluenceAuthService';
import { resolveConfluenceWebUrl } from '../confluence/confluenceWebUrl';
import { ghEnv } from '../codehost/ghCli';
import { adfText } from '../home/types';
import { request } from '../home/homeActivityService';
import { callNotesDir, listCallNotes, readCallNote } from '../callNotes';
import { readCallSummary } from '../callNoteSummary';
import type { WorkItem } from './brief';

export const WINDOW_DAYS = 365;
/** Per source; a year of one person's work is far below this. */
const MAX_ITEMS = 1000;
const DAY = 86_400_000;

export interface FetchResult {
  items: WorkItem[];
  /** One line per source that could not be read, for the brief's status and the prompt. */
  notes: string[];
  /** Sources that returned items. */
  read: string[];
  user?: string;
}

const ms = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const settingsConfig = (context: vscode.ExtensionContext): any => (context.globalState.get(STORAGE_KEYS.SETTINGS) as any)?.state?.config ?? {};

/** States that mean done in the default ADO processes. Anything else counts as open, which can only make it a full card. */
const ADO_DONE = new Set(['closed', 'done', 'removed', 'resolved', 'completed', 'cut']);

async function adoWork(context: vscode.ExtensionContext, since: number): Promise<{ items: WorkItem[]; user?: string; prs: WorkItem[]; prNote?: string }> {
  const config = settingsConfig(context).ado;
  if (!config?.orgName) throw new Error('not connected');
  const org = `https://dev.azure.com/${encodeURIComponent(config.orgName)}`;
  const auth = await new AdoAuthService(context).getValidAuthHeader();
  const identity = (await request(`${org}/_apis/connectionData`, auth)).authenticatedUser;
  if (!identity?.id) throw new Error('Could not identify the signed-in Azure DevOps user.');
  const days = Math.ceil((Date.now() - since) / DAY);
  // EVER finds items the user was assigned to or changed at any point, not only the latest values.
  const queries = [
    `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= @Today - ${days} AND ([System.AssignedTo] EVER @Me OR [System.CreatedBy] = @Me OR [System.ChangedBy] EVER @Me) ORDER BY [System.ChangedDate] DESC`,
    `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= @Today - ${days} AND ([System.AssignedTo] = @Me OR [System.CreatedBy] = @Me OR [System.ChangedBy] = @Me) ORDER BY [System.ChangedDate] DESC`,
  ];
  let ids: number[] = [];
  for (const [i, query] of queries.entries()) {
    try {
      const result = await request(`${org}/_apis/wit/wiql?api-version=7.1&$top=${MAX_ITEMS}`, auth, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
      });
      ids = (result.workItems ?? []).map((w: any) => w.id);
      break;
    } catch (err) {
      // An organisation that rejects EVER gets the plain query.
      if (i === queries.length - 1 || !/\(400\)/.test(message(err))) throw err;
    }
  }
  const fields = ['System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo', 'System.CreatedBy', 'System.ChangedBy',
    'System.CreatedDate', 'System.ChangedDate', 'System.TeamProject', 'System.Tags', 'System.Description', 'Microsoft.VSTS.Common.AcceptanceCriteria'];
  const items: WorkItem[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = await request(`${org}/_apis/wit/workitemsbatch?api-version=7.1`, auth, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids.slice(i, i + 200), fields, errorPolicy: 'Omit' }),
    });
    for (const w of batch.value ?? []) {
      if (!w?.id || !w.fields) continue;
      const f = w.fields;
      const isMe = (p: any) => !!p && (p.id === identity.id || (p.uniqueName && p.uniqueName === identity.properties?.Account?.$value));
      const roles = [isMe(f['System.AssignedTo']) && 'assigned', isMe(f['System.CreatedBy']) && 'created', isMe(f['System.ChangedBy']) && 'last changed']
        .filter(Boolean) as string[];
      const state = String(f['System.State'] ?? '');
      const project = String(f['System.TeamProject'] ?? config.projectName ?? '');
      const detail = [htmlToText(f['System.Description'] ?? ''), f['Microsoft.VSTS.Common.AcceptanceCriteria'] ? `Acceptance: ${htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria'])}` : '',
        f['System.Tags'] ? `Tags: ${f['System.Tags']}` : ''].filter(Boolean).join(' ');
      items.push({
        tag: `ADO #${w.id}`, source: 'ado', kind: String(f['System.WorkItemType'] ?? 'Work item'), title: String(f['System.Title'] ?? `#${w.id}`),
        url: `${org}/${encodeURIComponent(project)}/_workitems/edit/${w.id}`, state, ...(state ? { open: !ADO_DONE.has(state.toLowerCase()) } : {}),
        roles: roles.length ? roles : ['involved'],
        people: [f['System.AssignedTo']?.displayName && `Assigned to ${f['System.AssignedTo'].displayName}`, f['System.CreatedBy']?.displayName && `Created by ${f['System.CreatedBy'].displayName}`].filter(Boolean),
        updatedAt: ms(f['System.ChangedDate']), createdAt: ms(f['System.CreatedDate']) || undefined, where: project, text: detail,
      });
    }
  }

  // Pull requests in the connected project, created or reviewed by the user.
  const prs: WorkItem[] = [];
  let prNote: string | undefined;
  if (config.projectName) {
    const base = `${org}/${encodeURIComponent(config.projectName)}`;
    try {
      for (const [field, role] of [['creatorId', 'authored'], ['reviewerId', 'reviewed']] as const) {
        const result = await request(`${base}/_apis/git/pullrequests?api-version=7.1&searchCriteria.status=all&searchCriteria.${field}=${encodeURIComponent(identity.id)}` +
          `&searchCriteria.minTime=${encodeURIComponent(new Date(since).toISOString())}&searchCriteria.queryTimeRangeType=created&$top=500`, auth);
        for (const pr of result.value ?? []) {
          if (!pr?.pullRequestId) continue;
          const status = String(pr.status ?? '');
          prs.push({
            tag: `PR ado!${pr.pullRequestId}`, source: 'pr', kind: 'Pull request', title: String(pr.title ?? `!${pr.pullRequestId}`),
            url: `${base}/_git/${encodeURIComponent(pr.repository?.name ?? pr.repository?.id ?? '')}/pullrequest/${pr.pullRequestId}`,
            state: pr.isDraft && status === 'active' ? 'draft' : status, open: status === 'active', roles: [role],
            people: pr.createdBy?.displayName ? [`Author ${pr.createdBy.displayName}`] : [],
            updatedAt: ms(pr.closedDate) || ms(pr.creationDate), createdAt: ms(pr.creationDate) || undefined,
            where: pr.repository?.name, text: `${pr.sourceRefName ? `${String(pr.sourceRefName).replace('refs/heads/', '')} → ${String(pr.targetRefName ?? '').replace('refs/heads/', '')}. ` : ''}${pr.description ?? ''}`,
          });
        }
      }
    } catch (err) {
      prNote = `Azure DevOps pull requests: ${message(err)}`;
    }
  }
  return { items, prs, prNote, user: identity.providerDisplayName ?? config.userDisplayName };
}

async function jiraWork(context: vscode.ExtensionContext, since: number): Promise<WorkItem[]> {
  const authService = new JiraAuthService(context);
  const site = authService.getStoredSite();
  if (!site) throw new Error('not connected');
  const auth = await authService.getValidAuthHeader();
  const base = jiraApiBase(site.id);
  const me: string | undefined = (await request(`${base}/rest/api/3/myself`, auth)).accountId;
  const days = Math.ceil((Date.now() - since) / DAY);
  const jqls = [
    `(assignee = currentUser() OR reporter = currentUser() OR assignee WAS currentUser() OR issuekey IN updatedBy(currentUser(), "-${days}d")) AND updated >= -${days}d ORDER BY updated DESC`,
    `(assignee = currentUser() OR reporter = currentUser()) AND updated >= -${days}d ORDER BY updated DESC`,
  ];
  const fields = 'summary,status,issuetype,assignee,reporter,created,updated,description,labels,project';
  for (const [i, jql] of jqls.entries()) {
    try {
      const items: WorkItem[] = [];
      let token: string | undefined;
      do {
        const page = await request(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ''}`, auth);
        for (const issue of page.issues ?? []) {
          const f = issue.fields ?? {};
          const roles = [me && f.assignee?.accountId === me ? 'assigned' : '', me && f.reporter?.accountId === me ? 'reported' : ''].filter(Boolean);
          items.push({
            tag: `JIRA ${issue.key}`, source: 'jira', kind: f.issuetype?.name ?? 'Issue', title: f.summary ?? issue.key,
            url: `${site.url.replace(/\/$/, '')}/browse/${encodeURIComponent(issue.key)}`, state: f.status?.name,
            ...(f.status?.statusCategory?.key ? { open: f.status.statusCategory.key !== 'done' } : {}),
            roles: roles.length ? roles : ['involved'],
            people: [f.assignee?.displayName && `Assigned to ${f.assignee.displayName}`, f.reporter?.displayName && `Reported by ${f.reporter.displayName}`].filter(Boolean),
            updatedAt: ms(f.updated), createdAt: ms(f.created) || undefined, where: f.project?.key,
            text: [adfText(f.description), f.labels?.length ? `Labels: ${f.labels.join(', ')}` : ''].filter(Boolean).join(' '),
          });
        }
        token = page.isLast === false ? page.nextPageToken : undefined;
      } while (token && items.length < MAX_ITEMS);
      return items;
    } catch (err) {
      if (i === jqls.length - 1 || !/\(400\)/.test(message(err))) throw err;
    }
  }
  return [];
}

async function confluenceWork(context: vscode.ExtensionContext, since: number): Promise<WorkItem[]> {
  const config = settingsConfig(context).confluence;
  if (!config?.isConfluenceEnabled || !config?.isAuthenticated) throw new Error('not connected');
  const authService = new ConfluenceAuthService(context);
  const site = authService.getStoredSite();
  if (!site) throw new Error('not connected');
  const token = await authService.getValidAccessToken();
  const days = Math.ceil((Date.now() - since) / DAY);
  const cql = `contributor = currentUser() AND type IN (page, blogpost) AND lastmodified >= now("-${days}d") ORDER BY lastmodified DESC`;
  const api = `https://api.atlassian.com/ex/confluence/${site.id}/wiki`;
  const items: WorkItem[] = [];
  let next: string | undefined = `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=100&expand=content.version,content.space,content.history`;
  while (next && items.length < MAX_ITEMS) {
    const result: any = await request(`${api}${next}`, `Bearer ${token}`);
    for (const r of result.results ?? []) {
      const content = r.content;
      if (!content?.id) continue;
      const rawUrl = r.url || content._links?.webui;
      const url = rawUrl ? resolveConfluenceWebUrl(`${site.url.replace(/\/$/, '')}/wiki`, rawUrl, { ...result._links, ...r._links, ...content._links }) : undefined;
      const authored = content.history?.createdBy?.accountId && content.history.createdBy.accountId === content.version?.by?.accountId;
      items.push({
        tag: `PAGE ${content.id}`, source: 'confluence', kind: content.type === 'blogpost' ? 'Blog post' : 'Page', title: r.title ?? content.title ?? 'Untitled page',
        ...(url ? { url } : {}), roles: ['contributed'],
        people: [content.history?.createdBy?.displayName && `Created by ${content.history.createdBy.displayName}`, content.version?.by?.displayName && !authored && `Last edited by ${content.version.by.displayName}`].filter(Boolean),
        updatedAt: ms(content.version?.when ?? r.lastModified), createdAt: ms(content.history?.createdDate) || undefined,
        where: content.space?.name ?? content.space?.key, text: htmlToText(r.excerpt ?? ''),
      });
    }
    next = result._links?.next;
  }
  return items;
}

function gh(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { env: ghEnv(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error('GitHub CLI is not signed in (gh auth login).'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('GitHub returned an invalid response.')); }
    });
  });
}

/** github.com pull requests the user authored or reviewed, through an existing GitHub CLI sign-in. */
async function githubWork(since: number): Promise<WorkItem[]> {
  const date = new Date(since).toISOString().slice(0, 10);
  const items: WorkItem[] = [];
  for (const [flag, role] of [['--author', 'authored'], ['--reviewed-by', 'reviewed']] as const) {
    const rows = await gh(['search', 'prs', flag, '@me', '--updated', `>=${date}`, '--limit', '300',
      '--json', 'number,title,url,state,isDraft,updatedAt,createdAt,repository,body,author']);
    for (const pr of rows ?? []) {
      const repo = pr.repository?.nameWithOwner ?? '';
      const state = String(pr.state ?? '').toLowerCase();
      items.push({
        tag: `PR github ${repo}#${pr.number}`, source: 'pr', kind: 'Pull request', title: pr.title ?? `#${pr.number}`, url: pr.url,
        state: pr.isDraft && state === 'open' ? 'draft' : state, open: state === 'open', roles: [role],
        people: pr.author?.login ? [`Author ${pr.author.login}`] : [], updatedAt: ms(pr.updatedAt), createdAt: ms(pr.createdAt) || undefined,
        where: repo, text: String(pr.body ?? ''),
      });
    }
  }
  return items;
}

/** Transcript kept per call; a question about one call gets up to brief.ts DETAIL_TEXT_CHARS of it. */
const CALL_TEXT_CHARS = 4000;

/**
 * Call notes kept on this machine: the summary when there is one, then the
 * transcript. Local reads only, so workBrief.ts re-reads them on every
 * question and a call that just ended is already known.
 */
export async function callWork(context: vscode.ExtensionContext, since = Date.now() - WINDOW_DAYS * DAY): Promise<WorkItem[]> {
  const dir = callNotesDir(context.globalStorageUri.fsPath);
  const notes = (await listCallNotes(dir)).filter((n) => n.startedAt >= since && n.status === 'done');
  return Promise.all(notes.map(async (n): Promise<WorkItem> => {
    const s = await readCallSummary(dir, n.id).catch(() => undefined);
    const mine = s?.actions?.filter((a) => a.owner === 'you').map((a) => a.text) ?? [];
    const summary = s?.status === 'done'
      ? [s.tldr, s.highlights?.length ? `Highlights: ${s.highlights.join('; ')}` : '', s.decisions?.length ? `Decisions: ${s.decisions.join('; ')}` : '',
        mine.length ? `My actions: ${mine.join('; ')}` : ''].filter(Boolean).join(' ')
      : '';
    const note = await readCallNote(dir, n.id).catch(() => undefined);
    const heard = note?.turns.map((t) => `${t.speaker === 'you' ? 'Me' : 'Others'}: ${t.text}`).join(' ') ?? n.preview;
    const text = [summary || 'Not summarized yet.', heard ? `Transcript: ${heard}` : ''].filter(Boolean).join(' ').slice(0, CALL_TEXT_CHARS);
    return { tag: `CALL ${n.id}`, source: 'call', kind: 'Call', title: n.title, roles: ['attended'], updatedAt: n.endedAt ?? n.startedAt, createdAt: n.startedAt, text };
  }));
}

/** Every source in parallel; a source that fails adds a note instead of failing the brief. */
export async function fetchMyWork(context: vscode.ExtensionContext, windowDays = WINDOW_DAYS): Promise<FetchResult> {
  const since = Date.now() - windowDays * DAY;
  const out: FetchResult = { items: [], notes: [], read: [] };
  const take = async (name: string, job: () => Promise<WorkItem[]>) => {
    try {
      const items = await job();
      out.items.push(...items);
      if (items.length) out.read.push(name);
    } catch (err) {
      const why = message(err);
      // A source the user never connected is not a failure worth showing.
      if (why !== 'not connected') out.notes.push(`${name}: ${why}`);
    }
  };
  await Promise.all([
    take('Azure DevOps', async () => {
      const ado = await adoWork(context, since);
      out.user ??= ado.user;
      if (ado.prNote) out.notes.push(ado.prNote);
      return [...ado.items, ...ado.prs];
    }),
    take('Jira', () => jiraWork(context, since)),
    take('Confluence', () => confluenceWork(context, since)),
    take('GitHub', () => githubWork(since).catch((err) => {
      // No GitHub CLI or no sign-in: GitHub simply is not part of the brief.
      if (/not signed in/.test(message(err))) throw new Error('not connected');
      throw err;
    })),
    take('Call notes', () => callWork(context, since)),
  ]);
  out.user ??= settingsConfig(context).ado?.userDisplayName || undefined;
  return out;
}
