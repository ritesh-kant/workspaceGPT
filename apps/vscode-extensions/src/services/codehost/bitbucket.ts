import { BODY_CAP, COMMENT_BODY_CAP, COMMENT_CAP, CodeHostRequestError, PATCH_CAP, PATCH_TOTAL_CAP, cut, hostFetch, logTail } from './http';
import type { CiCheck, CodeHost, HomePr, ListPrsOptions, PrRef, PrSummary, RepoRef } from './types';

export const BITBUCKET_CLOUD = 'bitbucket.org';

const repoPath = (r: RepoRef) => `/repositories/${r.owner}/${r.repo}`;
const person = (u: any): string => u?.nickname ?? u?.display_name ?? 'unknown';
const prState = (s: string): PrRef['state'] => (s === 'MERGED' ? 'merged' : s === 'DECLINED' || s === 'SUPERSEDED' ? 'closed' : 'open');
const stateParams = (s: ListPrsOptions['state']) => (s === 'open' ? 'state=OPEN' : s === 'closed' ? 'state=MERGED&state=DECLINED' : 'state=OPEN&state=MERGED&state=DECLINED');

/**
 * Bitbucket Cloud (REST 2.0). Server / Data Center is a different API and is
 * not covered. Auth is Basic: the account email with an API token, or the
 * username with an app password.
 */
export class BitbucketHost implements CodeHost {
  readonly kind = 'bitbucket' as const;
  readonly prNoun = 'pull request';
  readonly host = BITBUCKET_CLOUD;
  private readonly basic: string;
  private uuid = '';

  constructor(username: string, token: string, public login = '') {
    this.basic = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    return hostFetch('Bitbucket', this.host, path.startsWith('http') ? path : `https://api.bitbucket.org/2.0${path}`, { Authorization: this.basic }, init);
  }

  private async json<T = any>(path: string, init?: RequestInit): Promise<T> {
    return (await this.fetch(path, init)).json() as Promise<T>;
  }

  async verify() {
    try {
      const user = await this.json<any>('/user');
      this.uuid = user.uuid;
      this.login = user.nickname || user.display_name;
      return { login: this.login };
    } catch (e) {
      // A token without account scope can't read /user but may still read repositories.
      if (!(e instanceof CodeHostRequestError) || e.status !== 403) throw e;
      await this.json('/repositories?role=member&pagelen=1');
      this.login = this.login || 'Bitbucket user';
      return { login: this.login, warning: 'This token cannot read your account, so "your PRs" and "to review" lists will be limited. Add the account:read scope.' };
    }
  }

  private async me(): Promise<string> {
    if (!this.uuid) await this.verify();
    if (!this.uuid) throw new Error('Bitbucket token needs the account:read scope to list your pull requests.');
    return this.uuid;
  }

  parseRemote(remote: string): RepoRef | undefined {
    const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)(?::\d+)?[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote.trim());
    return m && m[1].toLowerCase() === this.host ? { owner: m[2], repo: m[3] } : undefined;
  }

  async findPr(repo: RepoRef, branch: string): Promise<PrRef | null> {
    const q = encodeURIComponent(`source.branch.name="${branch.replace(/"/g, '')}"`);
    const res = await this.json<{ values: any[] }>(`${repoPath(repo)}/pullrequests?q=${q}&state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=10`);
    const p = res.values.find((x) => x.state === 'OPEN') ?? res.values[0];
    return p ? { number: p.id, url: p.links?.html?.href, branch: p.source?.branch?.name, sha: p.source?.commit?.hash ?? '', state: prState(p.state) } : null;
  }

  async checks(repo: RepoRef, pr: PrRef): Promise<CiCheck[]> {
    const res = await this.json<{ values: any[] }>(`${repoPath(repo)}/pullrequests/${pr.number}/statuses?pagelen=100`);
    return res.values.map((s): CiCheck => ({
      name: s.name || s.key || 'check',
      url: s.url || undefined,
      state: s.state === 'SUCCESSFUL' || s.state === 'STOPPED' ? 'pass' : s.state === 'FAILED' ? 'fail' : 'pending',
    }));
  }

  async failureLog(repo: RepoRef, checks: CiCheck[]): Promise<string | undefined> {
    const builds = [...new Set(checks.filter((c) => c.state === 'fail').map((c) => /\/results\/(\d+)/.exec(c.url ?? '')?.[1]).filter((x): x is string => !!x))].slice(0, 2);
    if (!builds.length) return undefined;
    const parts: string[] = [];
    for (const build of builds) {
      try {
        const steps = await this.json<{ values: any[] }>(`${repoPath(repo)}/pipelines/${build}/steps/`);
        for (const step of steps.values.filter((s) => s.state?.result?.name === 'FAILED').slice(0, 2)) {
          parts.push(`${step.name ?? 'step'}\n${logTail(await (await this.fetch(`${repoPath(repo)}/pipelines/${build}/steps/${encodeURIComponent(step.uuid)}/log`, { headers: { Accept: 'application/octet-stream' } })).text())}`);
        }
      } catch (e) {
        parts.push(`(could not read the log of pipeline ${build}: ${e instanceof Error ? e.message : 'unknown error'})`);
      }
    }
    return parts.length ? parts.join('\n\n---\n\n') : undefined;
  }

  private summary(p: any): PrSummary {
    return { number: p.id, title: p.title, state: p.state === 'OPEN' ? 'open' : p.state.toLowerCase(), draft: !!p.draft, author: person(p.author), branch: p.source?.branch?.name, base: p.destination?.branch?.name, updatedAt: p.updated_on, url: p.links?.html?.href, repository: p.destination?.repository?.full_name };
  }

  async listPrs(repo: RepoRef | undefined, opts: ListPrsOptions): Promise<PrSummary[]> {
    let path: string;
    if (opts.scope === 'repo') {
      if (!repo) throw new Error('Pass repo as "workspace/repo" to list Bitbucket pull requests.');
      path = `${repoPath(repo)}/pullrequests?${stateParams(opts.state)}&sort=-updated_on&pagelen=${opts.limit}`;
    } else if (opts.scope === 'mine') {
      path = `/pullrequests/${encodeURIComponent(await this.me())}?${stateParams(opts.state)}&sort=-updated_on&pagelen=${opts.limit}`;
    } else {
      if (!repo) throw new Error('Bitbucket can list review requests per repository only; pass repo as "workspace/repo".');
      path = `${repoPath(repo)}/pullrequests?q=${encodeURIComponent(`reviewers.uuid="${await this.me()}"`)}&${stateParams(opts.state)}&sort=-updated_on&pagelen=${opts.limit}`;
    }
    const res = await this.json<{ values: any[] }>(path);
    const rows = res.values.map((p) => this.summary(p));
    return repo && opts.scope === 'mine' ? rows.filter((r) => r.repository === `${repo.owner}/${repo.repo}`) : rows;
  }

  async getPr(repo: RepoRef, number: number, opts: { includeDiff: boolean; includeComments: boolean }) {
    const base = `${repoPath(repo)}/pullrequests/${number}`;
    const p = await this.json<any>(base);
    const reviewers = (p.participants ?? []).filter((x: any) => x.role === 'REVIEWER');
    const result: Record<string, unknown> = {
      repo: `${repo.owner}/${repo.repo}`, number, title: p.title, state: p.state === 'OPEN' ? 'open' : p.state.toLowerCase(), draft: !!p.draft, author: person(p.author),
      branch: p.source?.branch?.name, base: p.destination?.branch?.name, url: p.links?.html?.href, body: cut(p.description, BODY_CAP),
      reviewers: reviewers.map((r: any) => person(r.user)),
      reviews: reviewers.filter((r: any) => r.approved || r.state).map((r: any) => ({ by: person(r.user), state: r.approved ? 'APPROVED' : String(r.state).toUpperCase() })),
    };
    if (opts.includeDiff) {
      const [stat, diffText] = await Promise.all([
        this.json<{ values: any[] }>(`${base}/diffstat?pagelen=100`),
        this.fetch(`${base}/diff`, { headers: { Accept: 'text/plain' } }).then((r) => r.text()).catch(() => ''),
      ]);
      const patches = new Map<string, string>();
      for (const chunk of diffText.split(/^diff --git /m).slice(1)) {
        const path = /^a\/.+? b\/(.+)$/m.exec(chunk.split('\n')[0])?.[1];
        if (path) patches.set(path, chunk);
      }
      let budget = PATCH_TOTAL_CAP;
      let truncated = false;
      result.files = stat.values.map((f) => {
        const path = f.new?.path ?? f.old?.path;
        const full = patches.get(path);
        const patch = full ? full.slice(0, Math.min(PATCH_CAP, budget)) : undefined;
        if (patch !== undefined) budget -= patch.length;
        if (patch !== undefined && full && patch.length < full.length) truncated = true;
        return { path, status: f.status, additions: f.lines_added, deletions: f.lines_removed, ...(patch !== undefined ? { patch } : {}) };
      });
      if (truncated) result.truncated = 'Some of the diff was cut for size; read the file in the workspace or on Bitbucket for the rest.';
    }
    if (opts.includeComments) {
      const res = await this.json<{ values: any[] }>(`${base}/comments?pagelen=${COMMENT_CAP}`);
      result.comments = res.values.filter((c) => !c.deleted).map((c) => ({ by: person(c.user), ...(c.inline?.path ? { path: c.inline.path, line: c.inline.to } : {}), body: cut(c.content?.raw, COMMENT_BODY_CAP) }));
    }
    return result;
  }

  async createPr(repo: RepoRef, input: { base: string; head: string; title: string; body: string }): Promise<string> {
    try {
      const pr = await this.json<any>(`${repoPath(repo)}/pullrequests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.title, description: cut(input.body, 30_000), source: { branch: { name: input.head } }, destination: { branch: { name: input.base } } }),
      });
      return pr.links.html.href;
    } catch (e) {
      // A 400 here is usually "already an open pull request for this branch": that one is the answer.
      if (e instanceof CodeHostRequestError && e.status === 400) {
        const existing = await this.findPr(repo, input.head).catch(() => null);
        if (existing?.state === 'open') return existing.url;
      }
      throw e;
    }
  }

  async getIssue(repo: RepoRef, number: number, opts: { includeComments: boolean }) {
    const base = `${repoPath(repo)}/issues/${number}`;
    const issue = await this.json<any>(base).catch((e) => {
      if (e instanceof CodeHostRequestError && e.status === 404) throw new Error('Issue not found; the repository may not have Bitbucket issues enabled.');
      throw e;
    });
    const result: Record<string, unknown> = {
      repo: `${repo.owner}/${repo.repo}`, number, title: issue.title, state: issue.state, author: person(issue.reporter), assignees: issue.assignee ? [person(issue.assignee)] : [],
      labels: issue.kind ? [issue.kind] : [], url: issue.links?.html?.href, body: cut(issue.content?.raw, BODY_CAP),
    };
    if (opts.includeComments) {
      const res = await this.json<{ values: any[] }>(`${base}/comments?pagelen=${COMMENT_CAP}`);
      result.comments = res.values.map((c) => ({ by: person(c.user), body: cut(c.content?.raw, COMMENT_BODY_CAP) }));
    }
    return result;
  }

  async homePrs(repo?: RepoRef) {
    const uuid = await this.me();
    const mineRes = await this.json<{ values: any[] }>(`/pullrequests/${encodeURIComponent(uuid)}?state=OPEN&sort=-updated_on&pagelen=50`);
    const reviewRes = repo
      ? await this.json<{ values: any[] }>(`${repoPath(repo)}/pullrequests?q=${encodeURIComponent(`reviewers.uuid="${uuid}"`)}&state=OPEN&sort=-updated_on&pagelen=50`)
      : { values: [] as any[] };
    const items: HomePr[] = [];
    for (const [ownership, list] of [['mine', mineRes.values], ['review', reviewRes.values]] as const) {
      for (const p of list) {
        if (ownership === 'review' && p.author?.uuid === uuid) continue;
        const parts = p.participants ?? [];
        const state: HomePr['state'] = ownership === 'review' ? 'review-requested' : p.draft ? 'draft'
          : parts.some((x: any) => x.state === 'changes_requested') ? 'changes-requested' : parts.some((x: any) => x.approved) ? 'approved' : 'awaiting-review';
        items.push({ id: `bitbucket:${p.destination?.repository?.full_name}:${p.id}:${ownership}`, number: String(p.id), title: p.title, url: p.links?.html?.href,
          repository: p.destination?.repository?.full_name ?? '', author: person(p.author), updatedAt: p.updated_on, ownership, state, revisionParts: [p.updated_on, state] });
      }
    }
    return { items, limited: mineRes.values.length >= 50, coverage: 'Open Bitbucket PRs · yours everywhere, reviews for this workspace\'s repo' };
  }
}
