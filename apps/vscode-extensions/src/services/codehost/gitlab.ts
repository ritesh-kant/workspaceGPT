import { BODY_CAP, COMMENT_BODY_CAP, COMMENT_CAP, CodeHostRequestError, PATCH_CAP, PATCH_TOTAL_CAP, cut, hostFetch, logTail } from './http';
import type { CiCheck, CodeHost, HomePr, ListPrsOptions, PrRef, PrSummary, RepoRef } from './types';

const proj = (r: RepoRef) => `/projects/${encodeURIComponent(`${r.owner}/${r.repo}`)}`;
const person = (u: any): string => u?.username ?? 'unknown';
const prState = (s: string): PrRef['state'] => (s === 'merged' ? 'merged' : s === 'closed' || s === 'locked' ? 'closed' : 'open');

/** gitlab.com and self-managed GitLab, REST v4. A "pull request" here is a merge request. */
export class GitLabHost implements CodeHost {
  readonly kind = 'gitlab' as const;
  readonly prNoun = 'merge request';
  private readonly apiBase: string;

  constructor(readonly host: string, private readonly token: string, public login = '') {
    this.apiBase = `https://${host}/api/v4`;
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return hostFetch('GitLab', this.host, `${this.apiBase}${path}`, { Authorization: `Bearer ${this.token}` }, init);
  }

  private async json<T = any>(path: string, init?: RequestInit): Promise<T> {
    return (await this.fetch(path, init)).json() as Promise<T>;
  }

  async verify() {
    const user = await this.json<{ username: string }>('/user');
    this.login = user.username;
    return { login: user.username };
  }

  parseRemote(remote: string): RepoRef | undefined {
    const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim());
    if (!m || m[1].toLowerCase() !== this.host) return undefined;
    const slash = m[2].lastIndexOf('/');
    return slash > 0 ? { owner: m[2].slice(0, slash), repo: m[2].slice(slash + 1) } : undefined;
  }

  async findPr(repo: RepoRef, branch: string): Promise<PrRef | null> {
    const mrs = await this.json<any[]>(`${proj(repo)}/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&sort=desc&per_page=10`);
    const m = mrs.find((x) => x.state === 'opened') ?? mrs[0];
    return m ? { number: m.iid, url: m.web_url, branch: m.source_branch, sha: m.sha, state: prState(m.state) } : null;
  }

  async checks(repo: RepoRef, pr: PrRef): Promise<CiCheck[]> {
    const pipelines = await this.json<any[]>(`${proj(repo)}/pipelines?sha=${encodeURIComponent(pr.sha)}&per_page=1`);
    if (!pipelines[0]) return [];
    const jobs = await this.json<any[]>(`${proj(repo)}/pipelines/${pipelines[0].id}/jobs?per_page=100`);
    return jobs.map((j): CiCheck => {
      const url = j.web_url || undefined;
      switch (j.status) {
        case 'success':
        case 'skipped':
        case 'canceled':
        case 'manual':
          return { name: j.name, state: 'pass', url };
        case 'failed':
          // A job allowed to fail is reported but does not break the pipeline.
          return { name: j.name, state: j.allow_failure ? 'pass' : 'fail', url };
        default:
          return { name: j.name, state: 'pending', url };
      }
    });
  }

  async failureLog(repo: RepoRef, checks: CiCheck[]): Promise<string | undefined> {
    const ids = [...new Set(checks.filter((c) => c.state === 'fail').map((c) => /\/-\/jobs\/(\d+)/.exec(c.url ?? '')?.[1]).filter((x): x is string => !!x))].slice(0, 2);
    if (!ids.length) return undefined;
    const parts: string[] = [];
    for (const id of ids) {
      try {
        parts.push(logTail(await (await this.fetch(`${proj(repo)}/jobs/${id}/trace`, { headers: { Accept: 'text/plain' } })).text()));
      } catch (e) {
        parts.push(`(could not read the log of job ${id}: ${e instanceof Error ? e.message : 'unknown error'})`);
      }
    }
    return parts.join('\n\n---\n\n');
  }

  private summary(m: any): PrSummary {
    return { number: m.iid, title: m.title, state: m.state === 'opened' ? 'open' : m.state, draft: !!(m.draft ?? m.work_in_progress), author: person(m.author), branch: m.source_branch, base: m.target_branch, updatedAt: m.updated_at, url: m.web_url, repository: m.references?.full?.replace(/!\d+$/, '') };
  }

  async listPrs(repo: RepoRef | undefined, opts: ListPrsOptions): Promise<PrSummary[]> {
    const state = opts.state === 'open' ? 'opened' : opts.state === 'closed' ? 'closed' : 'all';
    const scopeQuery = opts.scope === 'mine' ? '&scope=created_by_me' : opts.scope === 'review-requested' ? `&reviewer_username=${encodeURIComponent(this.login || (await this.verify()).login)}&scope=all` : '';
    const root = repo ? proj(repo) : '';
    const mrs = await this.json<any[]>(`${root}/merge_requests?state=${state}${scopeQuery}&order_by=updated_at&sort=desc&per_page=${opts.limit}`);
    return mrs.map((m) => this.summary(m));
  }

  async getPr(repo: RepoRef, number: number, opts: { includeDiff: boolean; includeComments: boolean }) {
    const base = `${proj(repo)}/merge_requests/${number}`;
    const mr = await this.json<any>(base);
    const result: Record<string, unknown> = {
      repo: `${repo.owner}/${repo.repo}`, number, title: mr.title, state: mr.state === 'opened' ? 'open' : mr.state, draft: !!(mr.draft ?? mr.work_in_progress), author: person(mr.author),
      branch: mr.source_branch, base: mr.target_branch, url: mr.web_url, mergeStatus: mr.detailed_merge_status ?? mr.merge_status, labels: mr.labels ?? [],
      reviewers: (mr.reviewers ?? []).map(person), body: cut(mr.description, BODY_CAP), changedFiles: mr.changes_count,
    };
    const approvals = await this.json<any>(`${base}/approvals`).catch(() => null);
    if (approvals) result.reviews = (approvals.approved_by ?? []).map((a: any) => ({ by: person(a.user), state: 'APPROVED' }));
    if (opts.includeDiff) {
      // /diffs is the paginated endpoint (GitLab 15.7+); older servers only have /changes.
      const diffs = await this.json<any[]>(`${base}/diffs?per_page=100`).catch(async (e) => {
        if (e instanceof CodeHostRequestError && e.status === 404) return (await this.json<any>(`${base}/changes`)).changes as any[];
        throw e;
      });
      let budget = PATCH_TOTAL_CAP;
      let truncated = false;
      result.files = diffs.map((d) => {
        const patch = typeof d.diff === 'string' ? d.diff.slice(0, Math.min(PATCH_CAP, budget)) : undefined;
        if (patch !== undefined) budget -= patch.length;
        if (patch !== undefined && patch.length < d.diff.length) truncated = true;
        const status = d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified';
        return { path: d.new_path, status, ...(patch !== undefined ? { patch } : {}) };
      });
      if (truncated) result.truncated = 'Some of the diff was cut for size; read the file in the workspace or on GitLab for the rest.';
    }
    if (opts.includeComments) {
      const notes = await this.json<any[]>(`${base}/notes?per_page=${COMMENT_CAP}&sort=asc`);
      result.comments = notes.filter((n) => !n.system).map((n) => ({ by: person(n.author), ...(n.position?.new_path ? { path: n.position.new_path, line: n.position.new_line } : {}), body: cut(n.body, COMMENT_BODY_CAP) }));
    }
    return result;
  }

  async createPr(repo: RepoRef, input: { base: string; head: string; title: string; body: string }): Promise<string> {
    try {
      const mr = await this.json<{ web_url: string }>(`${proj(repo)}/merge_requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_branch: input.head, target_branch: input.base, title: input.title, description: cut(input.body, 100_000) }),
      });
      return mr.web_url;
    } catch (e) {
      // 409 = an open merge request for this branch already exists: that one is the answer.
      if (e instanceof CodeHostRequestError && e.status === 409) {
        const existing = await this.findPr(repo, input.head).catch(() => null);
        if (existing?.state === 'open') return existing.url;
      }
      throw e;
    }
  }

  async getIssue(repo: RepoRef, number: number, opts: { includeComments: boolean }) {
    const base = `${proj(repo)}/issues/${number}`;
    const issue = await this.json<any>(base);
    const result: Record<string, unknown> = {
      repo: `${repo.owner}/${repo.repo}`, number, title: issue.title, state: issue.state === 'opened' ? 'open' : issue.state, author: person(issue.author),
      assignees: (issue.assignees ?? []).map(person), labels: issue.labels ?? [], url: issue.web_url, body: cut(issue.description, BODY_CAP),
    };
    if (opts.includeComments) {
      const notes = await this.json<any[]>(`${base}/notes?per_page=${COMMENT_CAP}&sort=asc`);
      result.comments = notes.filter((n) => !n.system).map((n) => ({ by: person(n.author), body: cut(n.body, COMMENT_BODY_CAP) }));
    }
    return result;
  }

  async homePrs() {
    const me = this.login || (await this.verify()).login;
    const [mine, review] = await Promise.all([
      this.json<any[]>('/merge_requests?state=opened&scope=created_by_me&order_by=updated_at&sort=desc&per_page=50'),
      this.json<any[]>(`/merge_requests?state=opened&scope=all&reviewer_username=${encodeURIComponent(me)}&order_by=updated_at&sort=desc&per_page=50`),
    ]);
    const items: HomePr[] = [];
    for (const [ownership, list] of [['mine', mine], ['review', review]] as const) {
      for (const m of list) {
        if (ownership === 'review' && m.author?.username === me) continue;
        const state: HomePr['state'] = ownership === 'review' ? 'review-requested' : m.draft || m.work_in_progress ? 'draft' : 'awaiting-review';
        items.push({ id: `gitlab:${this.host}:${m.id}:${ownership}`, number: String(m.iid), title: m.title, url: m.web_url, repository: m.references?.full?.replace(/!\d+$/, '') ?? '',
          author: person(m.author), updatedAt: m.updated_at, ownership, state, revisionParts: [m.updated_at, m.sha, state] });
      }
    }
    return { items, limited: mine.length >= 50 || review.length >= 50, coverage: `Open GitLab merge requests${this.host === 'gitlab.com' ? '' : ` on ${this.host}`} · up to 50 per view` };
  }
}
