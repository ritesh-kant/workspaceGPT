import { execFile } from 'child_process';
import type { CodeHost, ListPrsOptions, RepoRef } from './types';
import { CodeHostConnections } from './connections';

/**
 * The agent's read-only code-host tools: list and read pull requests (merge
 * requests on GitLab) and read issues, on whichever host the repo lives on.
 * Reads only — nothing here writes to the host.
 */

function originOf(cwd: string): Promise<string> {
  return new Promise((resolve) =>
    execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 5_000, windowsHide: true }, (e, out) => resolve(e ? '' : out.trim())));
}

async function resolve(connections: CodeHostConnections, repoArg: unknown, cwd: string | undefined): Promise<{ host: CodeHost; repo: RepoRef | undefined }> {
  const fromWorkspace = cwd ? await connections.forRepo(cwd) : null;
  const given = typeof repoArg === 'string' ? repoArg.trim().replace(/\.git$/, '').replace(/^\/+|\/+$/g, '') : '';
  if (given) {
    const slash = given.lastIndexOf('/');
    if (slash < 1) throw new Error('Pass repo as "owner/name" (GitLab: "group/subgroup/name").');
    const repo = { owner: given.slice(0, slash), repo: given.slice(slash + 1) };
    // The workspace's own host first; otherwise the only connection there is.
    const hosts = await connections.hosts();
    const host = fromWorkspace?.host ?? (hosts.length === 1 ? hosts[0] : undefined);
    if (!host) throw new Error("Several code hosts are connected and this workspace's origin is on none of them; open that repository's folder.");
    return { host, repo };
  }
  if (fromWorkspace) return fromWorkspace;
  const remote = cwd ? await originOf(cwd) : '';
  const hosts = await connections.hosts();
  if (!hosts.length) throw new Error('No code host is connected. Connect GitHub, GitLab or Bitbucket in Settings.');
  throw new Error(`This workspace's origin${remote ? ` (${remote})` : ''} is not on a connected host. Connect that host in Settings, or pass repo as "owner/name".`);
}

export async function runCodeHostTool(name: string, args: any, connections: CodeHostConnections, cwd: string | undefined): Promise<unknown> {
  const { host, repo } = await resolve(connections, args?.repo, cwd);
  const repoName = repo ? `${repo.owner}/${repo.repo}` : undefined;
  const number = Number(args?.number);

  if (name === 'list_prs') {
    const opts: ListPrsOptions = {
      scope: args?.scope === 'mine' || args?.scope === 'review-requested' ? args.scope : 'repo',
      state: ['open', 'closed', 'all'].includes(args?.state) ? args.state : 'open',
      limit: Math.min(Math.max(Number(args?.limit) || 20, 1), 50),
    };
    return { host: host.host, repo: repoName, kind: host.prNoun, pullRequests: await host.listPrs(repo, opts) };
  }

  if (!repo) throw new Error('Pass repo as "owner/name".');
  if (!Number.isInteger(number) || number < 1) throw new Error('`number` must be the PR or issue number.');

  if (name === 'get_pr') {
    return { host: host.host, kind: host.prNoun, ...(await host.getPr(repo, number, { includeDiff: args?.includeDiff !== false, includeComments: !!args?.includeComments })) };
  }
  if (name === 'get_repo_issue') {
    return { host: host.host, ...(await host.getIssue(repo, number, { includeComments: !!args?.includeComments })) };
  }
  throw new Error(`Unknown code-host tool: ${name}`);
}
