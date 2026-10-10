import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { STORAGE_KEYS } from '../../../constants';
import { AdoAuthService } from '../ado/adoAuthService';
import { htmlToText } from '../ado/adoWorkItemService';
import { JiraAuthService, jiraApiBase } from '../jira/jiraAuthService';
import { ConfluenceAuthService } from '../confluence/confluenceAuthService';
import { resolveConfluenceWebUrl } from '../confluence/confluenceWebUrl';
import { getActiveTicketProvider } from '../tickets/registry';
import { CodeHostConnections } from '../codehost/connections';
import { ghEnv } from '../codehost/ghCli';
import type { CodeHost, RepoRef } from '../codehost/types';
import { HomeActivity, HomeMention, HomePullRequest, HomeSection, adoReviewState, adfText, hasJiraMention } from './types';

const LOOKBACK_DAYS = 30;
const ISSUE_LIMIT = 30;
const COMMENT_LIMIT = 100;
const recent = (date: string) => Date.parse(date) >= Date.now() - LOOKBACK_DAYS * 86_400_000;

export function activityRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

/** No response bodies or credentials in errors/analytics. Never follow auth-bearing redirects. */
async function request(url: string, authHeader: string, init?: RequestInit): Promise<any> {
  // Every call here is a read, so a transient gateway error is safe to retry.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
      headers: { Authorization: authHeader, Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    if (response.ok) return response.json();
    if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }
    throw new Error(response.status === 401 || response.status === 403
      ? 'Access denied. Reconnect this source and check its read permissions.'
      : `Could not refresh activity (${response.status}). Try again.`);
  }
}

async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function gh(args: string[], host?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { env: ghEnv(), timeout: 25_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error(`Sign in to GitHub CLI with gh auth login${host ? ` --hostname ${host}` : ''}, then refresh.`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('GitHub returned an invalid activity response.')); }
    });
  });
}

/** Jira is a ticket tracker, not a PR host. Reuse an existing local GitHub CLI sign-in. */
async function githubPullRequests(host?: string): Promise<HomeSection<HomePullRequest>> {
  const h = host && host !== 'github.com' ? ['--hostname', host] : [];
  const user = await gh(['api', ...h, 'user'], host);
  const fields = 'id number title url updatedAt isDraft reviewDecision author { login } repository { nameWithOwner }';
  const query = `query($mine:String!,$review:String!){
    mine:search(query:$mine,type:ISSUE,first:50){issueCount nodes{... on PullRequest{${fields}}}}
    review:search(query:$review,type:ISSUE,first:50){issueCount nodes{... on PullRequest{${fields}}}}
  }`;
  const mine = `is:pr is:open author:${user.login} sort:updated-desc`;
  const review = `is:pr is:open review-requested:${user.login} sort:updated-desc`;
  const result = await gh(['api', 'graphql', ...h, '-f', `query=${query}`, '-f', `mine=${mine}`, '-f', `review=${review}`], host);
  if (result.errors || !result.data) throw new Error('Could not refresh GitHub pull requests. Check your repository access.');
  const items: HomePullRequest[] = [];
  for (const ownership of ['mine', 'review'] as const) {
    for (const pr of result.data[ownership].nodes ?? []) {
      if (!pr?.id) continue;
      const state: HomePullRequest['state'] = ownership === 'review' ? 'review-requested'
        : pr.isDraft ? 'draft' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested'
          : pr.reviewDecision === 'APPROVED' ? 'approved' : 'awaiting-review';
      items.push({ id: `github:${user.id}:${pr.id}:${ownership}`, number: String(pr.number), title: pr.title, url: pr.url,
        source: 'github', repository: pr.repository.nameWithOwner, author: pr.author?.login ?? 'Unknown author',
        updatedAt: pr.updatedAt, ownership, state, revision: activityRevision([pr.updatedAt, state]) });
    }
  }
  return { items, limited: result.data.mine.issueCount > 50 || result.data.review.issueCount > 50, coverage: `Open GitHub PRs${host && host !== 'github.com' ? ` on ${host}` : ''} · up to 50 per view` };
}

/** Host of the open workspace's `origin` when it is GitHub-shaped (github.com or Enterprise), else undefined. */
async function workspaceGithubHost(): Promise<string | undefined> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return undefined;
  const remote = await new Promise<string>((resolve) =>
    execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5_000, windowsHide: true }, (e, out) => resolve(e ? '' : out.trim())));
  const host = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)[/:]/.exec(remote)?.[1];
  return host && !/dev\.azure\.com|visualstudio\.com|gitlab|bitbucket/.test(host) ? host : undefined;
}

/** One section from every connected code host's pull requests, plus the gh CLI as a fallback when none is connected. */
async function codeHostPullRequests(hosts: CodeHost[], repo: RepoRef | undefined): Promise<Array<PromiseSettledResult<HomeSection<HomePullRequest>>>> {
  return Promise.allSettled(hosts.map(async (host): Promise<HomeSection<HomePullRequest>> => {
    const { items, limited, coverage, warning } = await host.homePrs(repo);
    return {
      ...(warning ? { error: warning } : {}),
      items: items.map((pr): HomePullRequest => ({ ...pr, source: host.kind, revision: activityRevision(pr.revisionParts) })),
      limited,
      coverage,
    };
  }));
}

/** Tracker PRs (ADO) and code-host PRs listed together; with Jira only the code hosts are. */
async function trackerAndHostPullRequests(ado: ReturnType<typeof adoContext> | null, hosts: CodeHost[], repo: RepoRef | undefined): Promise<HomeSection<HomePullRequest>> {
  // No connected host: fall back to gh when the workspace's origin is GitHub-shaped.
  const ghHost = !hosts.length ? await workspaceGithubHost() : undefined;
  const settled = [
    ...(ado ? [await Promise.allSettled([ado.then(adoPullRequests)]).then((r) => r[0])] : []),
    ...(await codeHostPullRequests(hosts, repo)),
    ...(ghHost ? [await Promise.allSettled([githubPullRequests(ghHost)]).then((r) => r[0])] : []),
  ];
  const sections = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed && !sections.length) throw failed.reason;
  return {
    items: sections.flatMap((x) => x.items),
    limited: sections.some((x) => x.limited),
    coverage: sections.map((x) => x.coverage).filter(Boolean).join(' · '),
    ...((): { error?: string } => {
      const notes = [failed ? (failed.reason instanceof Error ? failed.reason.message : 'Could not refresh some pull requests.') : '', ...sections.map((x) => x.error ?? '')].filter(Boolean);
      return notes.length ? { error: notes.join(' ') } : {};
    })(),
  };
}

async function adoContext(context: vscode.ExtensionContext) {
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  const config = settings.state.config.ado;
  const org = `https://dev.azure.com/${encodeURIComponent(config.orgName)}`;
  const base = `${org}/${encodeURIComponent(config.projectName)}`;
  const auth = await new AdoAuthService(context).getValidAuthHeader();
  const connection = await request(`${org}/_apis/connectionData`, auth);
  const identity = connection.authenticatedUser;
  if (!identity?.id) throw new Error('Could not identify the signed-in Azure DevOps user.');
  return { base, auth, identity, scope: `${config.orgName}:${config.projectName}:${identity.id}` };
}

async function adoPullRequests(ctx: Awaited<ReturnType<typeof adoContext>>): Promise<HomeSection<HomePullRequest>> {
  const results = await Promise.all(['creatorId', 'reviewerId'].map((field) => request(
    `${ctx.base}/_apis/git/pullrequests?api-version=7.1&searchCriteria.status=active&searchCriteria.${field}=${encodeURIComponent(ctx.identity.id)}&$top=100`, ctx.auth)));
  const items: HomePullRequest[] = [];
  results.forEach((result, index) => {
    const ownership = index === 0 ? 'mine' : 'review';
    for (const pr of result.value ?? []) {
      const reviewers = pr.reviewers ?? [];
      // Requests already reviewed by the user leave "To review". Own PRs stay until closed/merged.
      if (ownership === 'review' && (pr.createdBy?.id === ctx.identity.id || !reviewers.some((r: any) => r.id === ctx.identity.id && Number(r.vote ?? 0) === 0))) continue;
      const state = ownership === 'review' ? 'review-requested' : adoReviewState(reviewers, !!pr.isDraft);
      items.push({ id: `ado:${ctx.scope}:${pr.pullRequestId}:${ownership}`, number: String(pr.pullRequestId),
        title: pr.title, url: `${ctx.base}/_git/${encodeURIComponent(pr.repository.id)}/pullrequest/${pr.pullRequestId}`,
        source: 'ado', repository: pr.repository.name, author: pr.createdBy?.displayName ?? 'Unknown author',
        // Azure DevOps has no updatedAt on this endpoint; don't label creation time as an update.
        updatedAt: '', ownership, state,
        revision: activityRevision([pr.lastMergeSourceCommit?.commitId, reviewers.map((r: any) => [r.id, r.vote]).sort(), state]) });
    }
  });
  return { items, limited: results.some((r) => (r.value?.length ?? 0) >= 100), coverage: 'Connected Azure DevOps project · open PRs' };
}

async function adoMentions(ctx: Awaited<ReturnType<typeof adoContext>>): Promise<HomeSection<HomeMention>> {
  const query = `SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.ChangedDate] >= @Today - ${LOOKBACK_DAYS} ORDER BY [System.ChangedDate] DESC`;
  const result = await request(`${ctx.base}/_apis/wit/wiql?api-version=7.1&$top=${ISSUE_LIMIT}`, ctx.auth, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const ids = (result.workItems ?? []).map((w: any) => w.id);
  const details = ids.length ? await request(`${ctx.base}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Title&api-version=7.1`, ctx.auth) : { value: [] };
  let partial = false;
  const rows = await mapLimited<any, HomeMention[]>(details.value ?? [], async (item) => {
    try {
      const comments = await request(`${ctx.base}/_apis/wit/workItems/${item.id}/comments?api-version=7.1-preview.4&$top=${COMMENT_LIMIT}&$expand=renderedText&order=desc`, ctx.auth);
      if (comments.continuationToken) partial = true;
      return (comments.comments ?? []).filter((c: any) => !c.isDeleted && recent(c.modifiedDate ?? c.createdDate) && (c.mentions ?? []).some((m: any) => String(m.targetId).toLowerCase() === String(ctx.identity.id).toLowerCase() && m.artifactType === 'person')).map((c: any) => ({
        id: `ado:${ctx.scope}:${item.id}:comment:${c.id ?? c.commentId}`, title: item.fields?.['System.Title'] ?? `#${item.id}`,
        url: `${ctx.base}/_workitems/edit/${item.id}?discussionCommentId=${c.id ?? c.commentId}`, source: 'ado' as const,
        author: c.createdBy?.displayName ?? 'Someone', excerpt: htmlToText(c.renderedText ?? c.text ?? '').slice(0, 280),
        updatedAt: c.modifiedDate ?? c.createdDate, revision: activityRevision([c.version, c.modifiedDate, c.text]),
      }));
    } catch { partial = true; return []; }
  });
  return { items: rows.flat(), limited: partial || ids.length >= ISSUE_LIMIT,
    ...(partial ? { error: 'Some comments could not be loaded. Refresh to retry.' } : {}),
    coverage: `Mentions in the ${ISSUE_LIMIT} most recently updated project tickets · last ${LOOKBACK_DAYS} days` };
}

export async function jiraMentions(context: vscode.ExtensionContext): Promise<HomeSection<HomeMention>> {
  const authService = new JiraAuthService(context);
  const site = authService.getStoredSite();
  if (!site) throw new Error('Reconnect Jira to load mentions.');
  const auth = await authService.getValidAuthHeader();
  const base = jiraApiBase(site.id);
  const user = await request(`${base}/rest/api/3/myself`, auth);
  if (!user.accountId) throw new Error('Could not identify the signed-in Jira user.');
  const config: any = (context.globalState.get<any>(STORAGE_KEYS.SETTINGS))?.state?.config?.jira;
  const jql = `project = ${JSON.stringify(config.projectKey)} AND updated >= -${LOOKBACK_DAYS}d ORDER BY updated DESC`;
  const result = await request(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${ISSUE_LIMIT}&fields=summary`, auth);
  let partial = false;
  const rows = await mapLimited<any, HomeMention[]>(result.issues ?? [], async (issue) => {
    try {
      const comments = await request(`${base}/rest/api/3/issue/${encodeURIComponent(issue.key)}/comment?maxResults=${COMMENT_LIMIT}&orderBy=-created`, auth);
      if (comments.total > COMMENT_LIMIT) partial = true;
      return (comments.comments ?? []).filter((c: any) => recent(c.updated ?? c.created) && hasJiraMention(c.body, user.accountId)).map((c: any) => ({
        id: `jira:${site.id}:${user.accountId}:${issue.key}:comment:${c.id}`, title: issue.fields?.summary ?? issue.key,
        url: `${site.url}/browse/${encodeURIComponent(issue.key)}?focusedCommentId=${encodeURIComponent(c.id)}`,
        source: 'jira' as const, author: c.author?.displayName ?? 'Someone', excerpt: adfText(c.body).slice(0, 280),
        updatedAt: c.updated ?? c.created, revision: activityRevision([c.updated, c.body]),
      }));
    } catch { partial = true; return []; }
  });
  return { items: rows.flat(), limited: partial || !result.isLast,
    ...(partial ? { error: 'Some comments could not be loaded. Refresh to retry.' } : {}),
    coverage: `Mentions in the ${ISSUE_LIMIT} most recently updated project tickets · last ${LOOKBACK_DAYS} days` };
}

export async function confluenceMentions(context: vscode.ExtensionContext): Promise<HomeSection<HomeMention>> {
  const authService = new ConfluenceAuthService(context);
  const site = authService.getStoredSite();
  if (!site) throw new Error('Reconnect Confluence to load mentions.');
  const token = await authService.getValidAccessToken();
  const accountScope = context.globalState.get<string>('confluence-home-account-scope', 'existing-connection');
  const spaceKey = context.globalState.get<any>(STORAGE_KEYS.SETTINGS)?.state?.config?.confluence?.spaceKey;
  const cql = `mention = currentUser() AND lastmodified >= now("-${LOOKBACK_DAYS}d")${spaceKey ? ` AND space = ${JSON.stringify(spaceKey)}` : ''} ORDER BY lastmodified DESC`;
  const result = await request(`https://api.atlassian.com/ex/confluence/${site.id}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=50&expand=content.version,content.body.storage`, `Bearer ${token}`);
  const items: HomeMention[] = (result.results ?? []).flatMap((r: any) => {
    const content = r.content;
    if (!content?.id || !(r.url || content._links?.webui)) return [];
    const rawUrl = r.url || content._links.webui;
    const url = resolveConfluenceWebUrl(`${site.url.replace(/\/$/, '')}/wiki`, rawUrl,
      { ...result._links, ...r._links, ...content._links });
    if (!url) return [];
    const version = content.version ?? {};
    return [{ id: `confluence:${site.id}:${accountScope}:${content.id}`, title: r.title ?? content.title ?? 'Confluence mention',
      url, source: 'confluence' as const, contentType: content.type === 'comment' ? 'comment' as const : 'page' as const, author: version.by?.displayName ?? 'Someone',
      excerpt: htmlToText(r.excerpt ?? content.body?.storage?.value ?? '').slice(0, 280),
      updatedAt: version.when ?? r.lastModified ?? '', revision: activityRevision([version.number, r.lastModified]) }];
  });
  return { items, limited: !!result._links?.next, coverage: `Pages and comments mentioning you · connected space · last ${LOOKBACK_DAYS} days` };
}

/** Stream independent sections: slow comment queries don't block tickets or PRs. */
export async function loadHomeActivity(context: vscode.ExtensionContext, onSection: <K extends keyof HomeActivity>(key: K, value: HomeActivity[K]) => void): Promise<void> {
  const provider = getActiveTicketProvider(context);
  const config = context.globalState.get<any>(STORAGE_KEYS.SETTINGS)?.state?.config;
  const ado = provider?.kind === 'ado' ? adoContext(context) : null;
  const connections = new CodeHostConnections(context);
  const hosts = await connections.hosts().catch(() => [] as CodeHost[]);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const target = workspaceFolder ? await connections.forRepo(workspaceFolder).catch(() => null) : null;
  const repo = target?.repo;
  // The workspace's host through the GitHub CLI's sign-in counts as connected too.
  if (target && !hosts.some((h) => h.kind === target.host.kind && h.host === target.host.host)) hosts.push(target.host);
  // No folder (or one on a host gh doesn't know): github.com through gh still lists the user's own PRs.
  if (!hosts.length) {
    const fallback = await connections.defaultGitHub().catch(() => null);
    if (fallback) hosts.push(fallback);
  }
  const jobs: Array<Promise<void>> = [];
  const run = <K extends keyof HomeActivity>(key: K, fn: () => Promise<HomeActivity[K]>) => {
    jobs.push(fn().then((value) => onSection(key, value)).catch((error) => onSection(key, { items: [], error: error instanceof Error ? error.message : 'Could not refresh activity.' } as HomeActivity[K])));
  };
  if (ado) {
    run('pullRequests', () => trackerAndHostPullRequests(ado, hosts, repo));
    run('trackerMentions', async () => adoMentions(await ado));
  } else if (provider?.kind === 'jira') {
    run('pullRequests', () => trackerAndHostPullRequests(null, hosts, repo));
    run('trackerMentions', () => jiraMentions(context));
  } else {
    onSection('pullRequests', { items: [], setup: 'Connect your ticket tracker to get started.' });
    onSection('trackerMentions', { items: [], setup: 'Choose Jira or Azure DevOps to see ticket mentions.' });
  }
  if (config?.confluence?.isConfluenceEnabled && config?.confluence?.isAuthenticated) {
    run('confluenceMentions', () => confluenceMentions(context));
  } else onSection('confluenceMentions', { items: [], setup: 'Connect Confluence to see page mentions.' });
  await Promise.all(jobs);
}
