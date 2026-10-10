import { BODY_CAP, COMMENT_BODY_CAP, COMMENT_CAP, CodeHostRequestError, PATCH_CAP, PATCH_TOTAL_CAP, cut, hostFetch, logTail } from './http';
import type { CiCheck, CodeHost, HomePr, ListPrsOptions, PrRef, PrSummary, RepoRef } from './types';

export const GITHUB_COM = 'github.com';

const PRS = (r: RepoRef) => `/repos/${r.owner}/${r.repo}`;
const person = (u: any): string => u?.login ?? 'unknown';

/** GitHub and GitHub Enterprise, over REST (+ GraphQL for Home). */
export class GitHubHost implements CodeHost {
  readonly kind = 'github' as const;
  readonly prNoun = 'pull request';
  private readonly apiBase: string;
  private readonly graphqlUrl: string;

  constructor(readonly host: string, private readonly token: string, public login = '') {
    this.apiBase = host === GITHUB_COM ? 'https://api.github.com' : `https://${host}/api/v3`;
    this.graphqlUrl = host === GITHUB_COM ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`;
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return hostFetch('GitHub', this.host, path.startsWith('http') ? path : `${this.apiBase}${path}`, {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, init);
  }

  private async json<T = any>(path: string, init?: RequestInit): Promise<T> {
    return (await this.fetch(path, init)).json() as Promise<T>;
  }

  async verify() {
    const response = await this.fetch('/user');
    const user = (await response.json()) as { login: string };
    this.login = user.login;
    // Classic tokens list their scopes; fine-grained tokens send none, so only warn when a list exists without repo.
    const scopes = response.headers.get('x-oauth-scopes');
    const warning = scopes && !/\brepo\b/.test(scopes) ? 'This token has no "repo" scope, so private repositories, PRs and checks will not load.' : undefined;
    return { login: user.login, warning };
  }

  parseRemote(remote: string): RepoRef | undefined {
    const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)(?::\d+)?[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
    return m && m[1].toLowerCase() === this.host ? { owner: m[2], repo: m[3] } : undefined;
  }

  async findPr(repo: RepoRef, branch: string): Promise<PrRef | null> {
    const prs = await this.json<any[]>(`${PRS(repo)}/pulls?head=${encodeURIComponent(`${repo.owner}:${branch}`)}&state=all&sort=updated&direction=desc&per_page=10`);
    const p = prs.find((x) => x.state === 'open') ?? prs[0];
    if (!p) return null;
    return { number: p.number, url: p.html_url, branch: p.head.ref, sha: p.head.sha, state: p.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open' };
  }

  async checks(repo: RepoRef, pr: PrRef): Promise<CiCheck[]> {
    const [runs, statuses] = await Promise.all([
      this.json<{ check_runs?: any[] }>(`${PRS(repo)}/commits/${pr.sha}/check-runs?per_page=100`),
      this.json<{ statuses?: any[] }>(`${PRS(repo)}/commits/${pr.sha}/status?per_page=100`),
    ]);
    const FAIL = new Set(['failure', 'timed_out', 'startup_failure', 'error', 'action_required']);
    const PASS = new Set(['success', 'neutral', 'skipped', 'cancelled', 'stale']);
    const fromRun = (c: any): CiCheck => {
      const url = c.html_url || c.details_url || undefined;
      if (c.status !== 'completed') return { name: c.name, state: 'pending', url };
      return { name: c.name, state: FAIL.has(c.conclusion) ? 'fail' : PASS.has(c.conclusion) ? 'pass' : 'pending', url };
    };
    const fromStatus = (c: any): CiCheck => ({
      name: c.context || 'check',
      url: c.target_url || undefined,
      state: c.state === 'success' ? 'pass' : c.state === 'failure' || c.state === 'error' ? 'fail' : 'pending',
    });
    return [...(runs.check_runs ?? []).map(fromRun), ...(statuses.statuses ?? []).map(fromStatus)];
  }

  async failureLog(repo: RepoRef, checks: CiCheck[]): Promise<string | undefined> {
    const jobIds = [...new Set(checks.filter((c) => c.state === 'fail').map((c) => /\/actions\/runs\/\d+\/job\/(\d+)/.exec(c.url ?? '')?.[1]).filter((x): x is string => !!x))].slice(0, 2);
    if (!jobIds.length) return undefined;
    const parts: string[] = [];
    for (const id of jobIds) {
      try {
        // The API answers with a redirect to the log blob; fetch drops the auth header across origins.
        parts.push(logTail(await (await this.fetch(`${PRS(repo)}/actions/jobs/${id}/logs`)).text()));
      } catch (e) {
        parts.push(`(could not read the log of job ${id}: ${e instanceof Error ? e.message : 'unknown error'})`);
      }
    }
    return parts.join('\n\n---\n\n');
  }

  async listPrs(repo: RepoRef | undefined, opts: ListPrsOptions): Promise<PrSummary[]> {
    if (opts.scope === 'repo' && repo) {
      const prs = await this.json<any[]>(`${PRS(repo)}/pulls?state=${opts.state}&sort=updated&direction=desc&per_page=${opts.limit}`);
      return prs.map((p) => ({ number: p.number, title: p.title, state: p.merged_at ? 'merged' : p.state, draft: !!p.draft, author: person(p.user), branch: p.head?.ref, base: p.base?.ref, updatedAt: p.updated_at, url: p.html_url }));
    }
    const qualifier = opts.scope === 'review-requested' ? 'review-requested:@me' : 'author:@me';
    const q = `is:pr ${repo ? `repo:${repo.owner}/${repo.repo}` : ''} ${opts.state === 'all' ? '' : `is:${opts.state}`} ${qualifier}`;
    const found = await this.json<{ items: any[] }>(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${opts.limit}`);
    return found.items.map((p) => ({ number: p.number, title: p.title, state: p.pull_request?.merged_at ? 'merged' : p.state, draft: !!p.draft, author: person(p.user), updatedAt: p.updated_at, url: p.html_url, repository: String(p.repository_url ?? '').split('/repos/')[1] }));
  }

  async getPr(repo: RepoRef, number: number, opts: { includeDiff: boolean; includeComments: boolean }) {
    const base = PRS(repo);
    const pr = await this.json<any>(`${base}/pulls/${number}`);
    const result: Record<string, unknown> = {
      repo: `${repo.owner}/${repo.repo}`, number, title: pr.title, state: pr.merged_at ? 'merged' : pr.state, draft: !!pr.draft, author: person(pr.user),
      branch: pr.head?.ref, base: pr.base?.ref, url: pr.html_url, mergeable: pr.mergeable, labels: (pr.labels ?? []).map((l: any) => l.name),
      reviewers: (pr.requested_reviewers ?? []).map(person), body: cut(pr.body, BODY_CAP), additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changed_files,
    };
    const [files, reviews] = await Promise.all([
      opts.includeDiff ? this.json<any[]>(`${base}/pulls/${number}/files?per_page=100`) : Promise.resolve([] as any[]),
      this.json<any[]>(`${base}/pulls/${number}/reviews?per_page=50`),
    ]);
    result.reviews = reviews.map((r) => ({ by: person(r.user), state: r.state, body: cut(r.body, COMMENT_BODY_CAP) })).filter((r) => r.state !== 'PENDING');
    let budget = PATCH_TOTAL_CAP;
    let truncated = pr.changed_files > files.length;
    result.files = files.map((f) => {
      const patch = typeof f.patch === 'string' ? f.patch.slice(0, Math.min(PATCH_CAP, budget)) : undefined;
      if (patch !== undefined) budget -= patch.length;
      if (patch !== undefined && patch.length < f.patch.length) truncated = true;
      return { path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(patch !== undefined ? { patch } : {}) };
    });
    if (opts.includeComments) {
      const [issueComments, reviewComments] = await Promise.all([
        this.json<any[]>(`${base}/issues/${number}/comments?per_page=${COMMENT_CAP}`),
        this.json<any[]>(`${base}/pulls/${number}/comments?per_page=${COMMENT_CAP}`),
      ]);
      result.comments = [
        ...issueComments.map((c) => ({ by: person(c.user), body: cut(c.body, COMMENT_BODY_CAP) })),
        ...reviewComments.map((c) => ({ by: person(c.user), path: c.path, line: c.line, body: cut(c.body, COMMENT_BODY_CAP) })),
      ];
    }
    if (truncated) result.truncated = 'Some of the diff was cut for size; read the file in the workspace or on GitHub for the rest.';
    return result;
  }

  async createPr(repo: RepoRef, input: { base: string; head: string; title: string; body: string }): Promise<string> {
    const path = `${PRS(repo)}/pulls`;
    try {
      const pr = await this.json<{ html_url: string }>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: cut(input.body, 30_000) }),
      });
      return pr.html_url;
    } catch (e) {
      // 422 = a PR for this branch is already open: that one is the answer.
      if (e instanceof CodeHostRequestError && e.status === 422) {
        const open = await this.json<{ html_url: string }[]>(`${path}?head=${encodeURIComponent(`${repo.owner}:${input.head}`)}&state=open`).catch(() => []);
        if (open[0]) return open[0].html_url;
      }
      throw e;
    }
  }

  async getIssue(repo: RepoRef, number: number, opts: { includeComments: boolean }) {
    const base = PRS(repo);
    const issue = await this.json<any>(`${base}/issues/${number}`);
    const result: Record<string, unknown> = {
      repo: `${repo.owner}/${repo.repo}`, number, title: issue.title, state: issue.state, author: person(issue.user), assignees: (issue.assignees ?? []).map(person),
      labels: (issue.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)), url: issue.html_url, isPullRequest: !!issue.pull_request, body: cut(issue.body, BODY_CAP),
    };
    if (opts.includeComments) {
      const comments = await this.json<any[]>(`${base}/issues/${number}/comments?per_page=${COMMENT_CAP}`);
      result.comments = comments.map((c) => ({ by: person(c.user), body: cut(c.body, COMMENT_BODY_CAP) }));
    }
    return result;
  }

  async homePrs() {
    const fields = 'id number title url updatedAt isDraft reviewDecision author { login } repository { nameWithOwner }';
    const query = `query($mine:String!,$review:String!){
      mine:search(query:$mine,type:ISSUE,first:50){issueCount nodes{... on PullRequest{${fields}}}}
      review:search(query:$review,type:ISSUE,first:50){issueCount nodes{... on PullRequest{${fields}}}}
    }`;
    const user = this.login || (await this.verify()).login;
    const response = await this.fetch(this.graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { mine: `is:pr is:open author:${user} sort:updated-desc`, review: `is:pr is:open review-requested:${user} sort:updated-desc` } }),
    });
    const result = (await response.json()) as any;
    // Search silently leaves out organizations whose SSO the token isn't authorized for.
    const warning = /partial-results|required/i.test(response.headers.get('x-github-sso') ?? '')
      ? `Some organizations on ${this.host} require SSO, so their pull requests are hidden. Authorize this token for them (Settings → Developer settings → Tokens → Configure SSO), then refresh.`
      : undefined;
    if (result.errors || !result.data) throw new Error('Could not refresh GitHub pull requests. Check your repository access.');
    const items: HomePr[] = [];
    for (const ownership of ['mine', 'review'] as const) {
      for (const pr of result.data[ownership].nodes ?? []) {
        if (!pr?.id) continue;
        const state: HomePr['state'] = ownership === 'review' ? 'review-requested'
          : pr.isDraft ? 'draft' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested'
            : pr.reviewDecision === 'APPROVED' ? 'approved' : 'awaiting-review';
        items.push({ id: `github:${this.host}:${pr.id}:${ownership}`, number: String(pr.number), title: pr.title, url: pr.url, repository: pr.repository.nameWithOwner,
          author: pr.author?.login ?? 'Unknown author', updatedAt: pr.updatedAt, ownership, state, revisionParts: [pr.updatedAt, state] });
      }
    }
    return { items, warning, limited: result.data.mine.issueCount > 50 || result.data.review.issueCount > 50, coverage: `Open ${this.host === GITHUB_COM ? 'GitHub' : this.host} PRs · up to 50 per view` };
  }
}
