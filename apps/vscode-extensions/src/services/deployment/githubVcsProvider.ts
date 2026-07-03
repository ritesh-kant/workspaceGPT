import type { CommitRef, VcsProvider } from '@workspace-gpt/release-core';
import { MachAuthService } from './machAuthService';

/**
 * Which GitHub repo the hotfix operates in. Kept explicit + org-agnostic — the
 * handler decides where these come from (typically the component monorepo whose
 * scoped `<component>-…` release tags are repo-scoped).
 */
export interface GitHubVcsOptions {
  apiBase: string;
  owner: string;
  repo: string;
  /** Branch commits are cherry-picked from / hotfix branches fork off. */
  defaultBranch: string;
}

interface GitCommitNode {
  sha: string;
  tree: string;
  parents: string[];
  message: string;
}

/**
 * A {@link VcsProvider} over the GitHub REST API, authenticated with the mach
 * classic PAT (scopes `repo` + `workflow`; `repo` covers commit search, git-data
 * writes, tags and releases — including the SAML-SSO'd Mars orgs the PAT is
 * self-authorized for).
 *
 * The interesting part is {@link cherryPick}: GitHub has no cherry-pick endpoint,
 * so we replay the well-known Git-Data-API algorithm (sibling-commit → merge →
 * reparent) per commit. Everything is read-only until `apply`, and the whole
 * hotfix lands on a dedicated `hotfix/*` branch, never on the default branch.
 */
export class GitHubVcsProvider implements VcsProvider {
  constructor(
    private readonly auth: MachAuthService,
    private readonly opts: GitHubVcsOptions,
  ) {}

  private async headers(json = false): Promise<Record<string, string>> {
    const token = await this.auth.requireToken();
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workspacegpt',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private base(): string {
    return `${this.opts.apiBase}/repos/${this.opts.owner}/${this.opts.repo}`;
  }

  private async gh(path: string, init?: RequestInit): Promise<any> {
    const headers = await this.headers(init?.method != null && init.method !== 'GET');
    const res = await fetch(`${this.base()}${path}`, { ...init, headers: { ...headers, ...(init?.headers as any) } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${body}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /* ----------------------------- find commits ----------------------------- */

  /**
   * Find commits whose message carries the ticket reference. Uses the commit
   * search API scoped to this repo; falls back to the ticket verbatim as the
   * query term. Returns the first line of each message as the title (the planner
   * derives the component from the Conventional-Commit scope).
   */
  async findCommitsByTicket(ticket: string): Promise<CommitRef[]> {
    const q = encodeURIComponent(`repo:${this.opts.owner}/${this.opts.repo} ${ticket}`);
    const url = `${this.opts.apiBase}/search/commits?q=${q}&per_page=100`;
    const headers = await this.headers();
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GitHub commit search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { items?: Array<{ sha: string; commit: { message: string } }> };
    return (data.items ?? []).map((it) => ({
      sha: it.sha,
      title: it.commit.message.split('\n')[0].trim(),
    }));
  }

  /* ------------------------------ cherry-pick ----------------------------- */

  private async getRef(ref: string): Promise<string | null> {
    try {
      const data = await this.gh(`/git/ref/${ref}`);
      return data.object.sha as string;
    } catch (e: any) {
      if (String(e?.message ?? '').includes('(404)')) return null;
      throw e;
    }
  }

  private async getCommit(sha: string): Promise<GitCommitNode> {
    const data = await this.gh(`/git/commits/${sha}`);
    return {
      sha: data.sha,
      tree: data.tree.sha,
      parents: (data.parents ?? []).map((p: any) => p.sha),
      message: data.message,
    };
  }

  private async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
    const data = await this.gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message, tree, parents }),
    });
    return data.sha as string;
  }

  private async setRef(ref: string, sha: string, force = true): Promise<void> {
    await this.gh(`/git/refs/${ref}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha, force }),
    });
  }

  private async createRef(ref: string, sha: string): Promise<void> {
    await this.gh('/git/refs', {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/${ref}`, sha }),
    });
  }

  /** Ensure `heads/<branch>` exists, forking it off the default branch if absent. */
  async ensureBranch(branch: string): Promise<void> {
    const existing = await this.getRef(`heads/${branch}`);
    if (existing) return;
    const baseSha = await this.getRef(`heads/${this.opts.defaultBranch}`);
    if (!baseSha) throw new Error(`Default branch ${this.opts.defaultBranch} not found`);
    await this.createRef(`heads/${branch}`, baseSha);
  }

  /**
   * Cherry-pick commits onto `branch` in order, via the Git Data API. For each
   * commit we: create a sibling commit (target's tree, but re-parented onto the
   * picked commit's parent) so the picked commit can be merged in; merge the
   * picked commit to obtain the combined tree; then create the real cherry-pick
   * commit with that tree parented on the original target head, and fast-forward
   * the branch to it. A merge conflict surfaces as an error (the 409 from the
   * merge endpoint) — never a silent bad tree.
   */
  async cherryPick(branch: string, shas: string[]): Promise<void> {
    await this.ensureBranch(branch);
    for (const sha of shas) {
      await this.cherryPickOne(branch, sha);
    }
  }

  private async cherryPickOne(branch: string, sha: string): Promise<void> {
    const headSha = await this.getRef(`heads/${branch}`);
    if (!headSha) throw new Error(`Branch ${branch} vanished mid-cherry-pick`);
    const head = await this.getCommit(headSha);
    const pick = await this.getCommit(sha);
    const pickParent = pick.parents[0];
    if (!pickParent) throw new Error(`Commit ${sha.slice(0, 7)} has no parent — cannot cherry-pick a root commit`);

    // 1. Sibling: head's tree, re-parented onto the picked commit's parent.
    const siblingSha = await this.createCommit(
      `cherry-pick base for ${sha.slice(0, 7)}`,
      head.tree,
      [pickParent],
    );
    // 2. Point the branch at the sibling so we can merge the pick into it.
    await this.setRef(`heads/${branch}`, siblingSha);
    // 3. Merge the picked commit — GitHub computes the combined tree (409 = conflict).
    let mergeTree: string;
    try {
      const merge = await this.gh('/merges', {
        method: 'POST',
        body: JSON.stringify({ base: branch, head: sha, commit_message: `merge ${sha.slice(0, 7)}` }),
      });
      mergeTree = merge.tree.sha as string;
    } catch (e: any) {
      // Restore the branch head before surfacing the conflict.
      await this.setRef(`heads/${branch}`, headSha);
      if (String(e?.message ?? '').includes('(409)')) {
        throw new Error(`Cherry-pick of ${sha.slice(0, 7)} conflicts on ${branch}; resolve manually`);
      }
      throw e;
    }
    // 4. Real cherry-pick commit: merged tree, parented on the ORIGINAL head.
    const cherrySha = await this.createCommit(pick.message, mergeTree, [headSha]);
    // 5. Fast-forward the branch to the clean cherry-pick, discarding the sibling.
    await this.setRef(`heads/${branch}`, cherrySha);
  }

  /* -------------------------------- tags ---------------------------------- */

  /**
   * Create an annotated tag at `ref` (a branch name or SHA) and its ref.
   * Idempotent: if `tags/<tag>` already exists it's left untouched (a release tag
   * is never silently moved), so a retry is safe.
   */
  async createTag(tag: string, ref: string): Promise<void> {
    if (await this.getRef(`tags/${tag}`)) return; // already tagged — don't move it
    // Resolve a branch name to a SHA; accept a raw SHA as-is.
    let sha = /^[0-9a-f]{7,40}$/i.test(ref) ? ref : null;
    if (!sha) sha = await this.getRef(`heads/${ref}`);
    if (!sha) throw new Error(`Cannot resolve tag ref ${ref}`);
    const obj = await this.gh('/git/tags', {
      method: 'POST',
      body: JSON.stringify({ tag, message: tag, object: sha, type: 'commit' }),
    });
    await this.createRef(`tags/${tag}`, obj.sha as string);
  }

  /* ------------------------------ releases -------------------------------- */

  /** Create a GitHub Release for the tag. Idempotent: returns the existing one if present. */
  async createRelease(tag: string, name: string): Promise<{ url: string }> {
    try {
      const data = await this.gh('/releases', {
        method: 'POST',
        body: JSON.stringify({ tag_name: tag, name, body: `Hotfix release ${name}` }),
      });
      return { url: data.html_url as string };
    } catch (e: any) {
      // 422 = a release for this tag already exists — fetch and return it.
      if (String(e?.message ?? '').includes('(422)')) {
        const existing = await this.gh(`/releases/tags/${encodeURIComponent(tag)}`);
        return { url: existing.html_url as string };
      }
      throw e;
    }
  }

  /**
   * List existing tag names that start with `prefix` (paginated). Used to derive
   * a component's current base version + already-taken hotfix ordinals. Returns
   * `[]` rather than throwing when the repo has no tags.
   */
  async listTags(prefix: string): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const tags = (await this.gh(`/tags?per_page=100&page=${page}`)) as Array<{ name: string }>;
      if (!tags.length) break;
      for (const t of tags) if (t.name.startsWith(prefix)) names.push(t.name);
      if (tags.length < 100) break;
    }
    return names;
  }
}
