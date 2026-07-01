import type {
  ActionContext,
  ActionOutcome,
  ActionPlan,
  ActionRef,
  ConfigVarDiff,
  PipelineAction,
} from '@workspace-gpt/release-core';
import {
  type MachRepoConfig,
  renderRepoName,
} from '../../../constants';
import { MachAuthService } from './machAuthService';

export interface MachSyncOptions {
  /** Repo topology (monorepo/workflow/repo-naming), configured per install in Settings. */
  repo: MachRepoConfig;
  brand: string;
  /** Source environment (e.g. test01) — read from here. */
  from: string;
  /** Destination environment (e.g. stage) — the PR lands here. */
  to: string;
  /** Branch of the source repo to read `components.yml` from. */
  fromBranch: string;
  /** Whether the workflow should also sync `main.yml` env vars. */
  updateMainYml: boolean;
  /**
   * Whether the promotion PR may auto-merge. Per-environment policy (declared in
   * settings), defaulting to false. Auto-merge is force-disabled for `stage`
   * regardless, so it's never silently merged into the pre-prod env.
   */
  autoMerge?: boolean;
  /**
   * MACH-promotion mode (default true). When false, this is a plain
   * `workflow_dispatch`: {@link inputs} are sent verbatim, and the component
   * diff / env-repo concepts don't apply.
   */
  machMode?: boolean;
  /** Generic dispatch inputs (only used when {@link machMode} is false). */
  inputs?: Record<string, string>;
}

/** One component's version delta between source and destination `components.yml`. */
export interface MachComponentChange {
  component: string;
  /** Version in the destination repo today (null when the component is new there). */
  current: string | null;
  /** Version in the source repo. */
  desired: string;
  /**
   * `update` — version differs, the PR will change it.
   * `match`  — already equal, no change.
   * `manual` — present in source but not destination; the workflow leaves these
   *            for a human to add, so they won't be in the PR.
   * `skip`   — marked `@skipdeploy` in the source, intentionally excluded.
   */
  action: 'update' | 'match' | 'manual' | 'skip';
}

export interface MachRunRef {
  runId: number;
  /** GitHub Actions run page. */
  runUrl: string;
  status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  conclusion?: string | null;
}

export interface MachPullRef {
  url: string;
  number: number;
  state: string;
  merged: boolean;
  title: string;
}

/**
 * Drives the mach (backend) config sync via the monorepo's
 * "[deploy] Sync Components Across Environments" workflow.
 *
 * Unlike Vercel, mach is NOT a per-variable push: the workflow promotes
 * component *versions* from a source environment's `components.yml` into a
 * destination's, then opens a PR. So the desired state comes from the source
 * mach repo, not the Confluence config table, and "apply" is a single
 * `workflow_dispatch` (never auto-merged — and `to == stage` forces auto-merge
 * off regardless). We surface a faithful read-only diff first, then the PR URL.
 */
export class MachSyncTarget implements PipelineAction {
  readonly id = 'mach';
  /** Triggered promotion, but still a `deploy` step from the pipeline's view. */
  readonly category = 'deploy' as const;
  private workflowId?: number;

  constructor(
    private readonly auth: MachAuthService,
    private readonly opts: MachSyncOptions,
  ) {}

  /* --------------------------------------------------------------- */
  /* PipelineAction conformance — thin wrappers over the mach-native  */
  /* methods below, so the runner can treat mach like any other       */
  /* deploy action. The richer handler flow (PR rename, webapp inject)*/
  /* still calls the native methods directly.                         */
  /* --------------------------------------------------------------- */

  /** Read-only preview: the component-version diff the workflow would apply. */
  async plan(_ctx: ActionContext): Promise<ActionPlan> {
    const changes = await this.planComponentDiff();
    const updates = changes.filter((c) => c.action === 'update').length;
    return {
      actionId: this.id,
      category: this.category,
      preview: changes,
      summary: `${updates} component version change(s) ${this.opts.from} → ${this.opts.to}`,
    };
  }

  /** Trigger the promotion. The PR/run arrives asynchronously — poll via {@link poll}. */
  async apply(ctx: ActionContext, _approved?: ConfigVarDiff[]): Promise<ActionOutcome> {
    const { workflowId, run } = await this.dispatchSync(ctx.now);
    const refs: ActionRef[] = run
      ? [{ kind: 'github-run', id: run.runId, url: run.runUrl }]
      : [{ kind: 'github-workflow', id: workflowId }];
    return { actionId: this.id, status: 'pending', refs };
  }

  /** Poll a dispatched run to completion, surfacing the opened PR when present. */
  async poll(ref: ActionRef): Promise<ActionOutcome> {
    if (ref.kind !== 'github-run') {
      return { actionId: this.id, status: 'pending', refs: [ref] };
    }
    const runId = Number(ref.id);
    const run = await this.getRunStatus(runId);
    const pr = await this.findPullRequest(runId);
    const refs: ActionRef[] = [{ kind: 'github-run', id: run.runId, url: run.runUrl }];
    if (pr) refs.push({ kind: 'pull-request', id: pr.number, url: pr.url });
    const status: ActionOutcome['status'] =
      run.status === 'completed'
        ? run.conclusion === 'success'
          ? 'applied'
          : 'failed'
        : 'pending';
    return { actionId: this.id, status, refs };
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.auth.requireToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workspacegpt',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** Destination repo name, derived from the configured `repoTemplate`. */
  private destRepo(): string {
    return renderRepoName(this.opts.repo.repoTemplate, this.opts.brand, this.opts.to);
  }

  private srcRepo(): string {
    return renderRepoName(this.opts.repo.repoTemplate, this.opts.brand, this.opts.from);
  }

  /** Resolve the workflow's numeric id by its display name (paginated list). */
  private async resolveWorkflowId(): Promise<number> {
    if (this.workflowId) return this.workflowId;
    const headers = await this.headers();
    for (let page = 1; page <= 10; page++) {
      const url = `${this.opts.repo.apiBase}/repos/${this.opts.repo.monorepoOwner}/${this.opts.repo.monorepoRepo}/actions/workflows?per_page=100&page=${page}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`Could not list monorepo workflows (${res.status}): ${(await res.text()).slice(0, 200)}`);
      }
      const data: any = await res.json();
      const list: any[] = data?.workflows ?? [];
      const found = list.find((w) => w.name === this.opts.repo.workflowName);
      if (found?.id) {
        this.workflowId = found.id;
        return found.id;
      }
      if (list.length < 100) break; // last page
    }
    throw new Error(`Workflow "${this.opts.repo.workflowName}" not found in ${this.opts.repo.monorepoRepo}.`);
  }

  /** Fetch and decode a text file from a repo at a ref (null if absent). */
  private async fetchFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
    const headers = await this.headers();
    const url = `${this.opts.repo.apiBase}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Read ${owner}/${repo}/${filePath} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const data: any = await res.json();
    if (typeof data?.content !== 'string') return null;
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }

  /**
   * Compute the version diff exactly as the workflow does: walk `components.yml`
   * line-by-line, honoring a `@skipdeploy` marker on the line *before* a
   * component, and only treating a component as changeable when it exists in both
   * repos with a differing version (new-in-source is left for manual add).
   */
  async planComponentDiff(): Promise<MachComponentChange[]> {
    const srcText = await this.fetchFile(
      this.opts.repo.destOwner,
      this.srcRepo(),
      'components.yml',
      this.opts.fromBranch,
    );
    if (srcText === null) {
      throw new Error(`Source ${this.srcRepo()} has no components.yml on "${this.opts.fromBranch}".`);
    }
    const destText = await this.fetchFile(this.opts.repo.destOwner, this.destRepo(), 'components.yml', 'main');
    if (destText === null) {
      throw new Error(`Destination ${this.destRepo()} has no components.yml on main.`);
    }

    const source = parseComponents(srcText);
    const dest = parseComponents(destText).versions;

    const changes: MachComponentChange[] = [];
    for (const { name, version, skip } of source.ordered) {
      if (skip) {
        changes.push({ component: name, current: dest.get(name) ?? null, desired: version, action: 'skip' });
        continue;
      }
      const current = dest.get(name);
      if (current === undefined) {
        changes.push({ component: name, current: null, desired: version, action: 'manual' });
      } else if (current !== version) {
        changes.push({ component: name, current, desired: version, action: 'update' });
      } else {
        changes.push({ component: name, current, desired: version, action: 'match' });
      }
    }
    return changes;
  }

  /**
   * Dispatch the sync workflow. `workflow_dispatch` returns 204 with no run id
   * and the run takes a few seconds to register, so we do NOT block on finding
   * it — we return the workflow id + dispatch time and a best-effort `run` (often
   * null right after dispatch). The caller polls {@link findRun} →
   * {@link findPullRequest} from there. Never auto-merges to stage.
   */
  async dispatchSync(sinceIso: string): Promise<{ workflowId: number; run: MachRunRef | null }> {
    const headers = await this.headers();
    const id = await this.resolveWorkflowId();

    const dispatchUrl = `${this.opts.repo.apiBase}/repos/${this.opts.repo.monorepoOwner}/${this.opts.repo.monorepoRepo}/actions/workflows/${id}/dispatches`;
    // Per-env policy (default off), but stage is never auto-merged regardless.
    const autoMerge = this.opts.to === 'stage' ? false : this.opts.autoMerge === true;
    // Generic dispatch sends the user's inputs verbatim; MACH mode builds the
    // sync workflow's fixed input contract from the promotion settings.
    const inputs =
      this.opts.machMode === false
        ? this.opts.inputs ?? {}
        : {
            brand: this.opts.brand,
            from: this.opts.from,
            to: this.opts.to,
            from_branch: this.opts.fromBranch,
            auto_merge_pr: String(autoMerge),
            update_main_yml: String(this.opts.updateMainYml),
          };
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: this.opts.repo.monorepoRef, inputs }),
    });
    if (!res.ok) {
      throw new Error(`workflow_dispatch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }

    // Best-effort: the run usually isn't queryable yet; null is expected here.
    const run = await this.findRun(id, sinceIso);
    return { workflowId: id, run };
  }

  /** Find the workflow run created on/after `sinceIso` (a few tries, short waits). */
  async findRun(workflowId: number | undefined, sinceIso: string): Promise<MachRunRef | null> {
    const headers = await this.headers();
    const id = workflowId ?? (await this.resolveWorkflowId());
    const since = Date.parse(sinceIso) - 5000; // small buffer for clock skew
    const url = `${this.opts.repo.apiBase}/repos/${this.opts.repo.monorepoOwner}/${this.opts.repo.monorepoRepo}/actions/workflows/${id}/runs?event=workflow_dispatch&per_page=10`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data: any = await res.json();
    const runs: any[] = data?.workflow_runs ?? [];
    const match = runs
      .filter((r) => Date.parse(r.created_at) >= since)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!match) return null;
    return {
      runId: match.id,
      runUrl: match.html_url,
      status: match.status ?? 'unknown',
      conclusion: match.conclusion,
    };
  }

  /** Current status of a known run. */
  async getRunStatus(runId: number): Promise<MachRunRef> {
    const headers = await this.headers();
    const url = `${this.opts.repo.apiBase}/repos/${this.opts.repo.monorepoOwner}/${this.opts.repo.monorepoRepo}/actions/runs/${runId}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Run status failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const r: any = await res.json();
    return { runId, runUrl: r.html_url, status: r.status ?? 'unknown', conclusion: r.conclusion };
  }

  /**
   * Find the PR the workflow opened for a given run. The workflow pushes to
   * `sync-from-<from>-to-<to>-<run_id>` in the destination repo, so we match on
   * that head branch.
   */
  async findPullRequest(runId: number): Promise<MachPullRef | null> {
    const headers = await this.headers();
    const branch = `sync-from-${this.opts.from}-to-${this.opts.to}-${runId}`;
    const url =
      `${this.opts.repo.apiBase}/repos/${this.opts.repo.destOwner}/${this.destRepo()}/pulls` +
      `?head=${this.opts.repo.destOwner}:${encodeURIComponent(branch)}&state=all&per_page=5`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const list: any[] = await res.json();
    const pr = list[0];
    if (!pr) return null;
    return { url: pr.html_url, number: pr.number, state: pr.state, merged: !!pr.merged_at, title: pr.title ?? '' };
  }

  /** The branch the workflow pushes for a given run. */
  syncBranch(runId: number): string {
    return `sync-from-${this.opts.from}-to-${this.opts.to}-${runId}`;
  }

  /** Read a file from the destination repo at a branch, with its blob sha. */
  async readDestFile(branch: string, filePath: string): Promise<{ content: string; sha: string } | null> {
    const headers = await this.headers();
    const url = `${this.opts.repo.apiBase}/repos/${this.opts.repo.destOwner}/${this.destRepo()}/contents/${filePath}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Read ${this.destRepo()}/${filePath}@${branch} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const data: any = await res.json();
    if (typeof data?.content !== 'string' || !data?.sha) return null;
    return {
      content: Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'),
      sha: data.sha,
    };
  }

  /** Commit a file update to a branch in the destination repo (PR updates itself). */
  async commitDestFile(
    branch: string,
    filePath: string,
    content: string,
    sha: string,
    message: string,
  ): Promise<void> {
    const headers = await this.headers();
    const url = `${this.opts.repo.apiBase}/repos/${this.opts.repo.destOwner}/${this.destRepo()}/contents/${filePath}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
        sha,
        branch,
      }),
    });
    if (!res.ok) {
      throw new Error(`Commit ${filePath}@${branch} failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  }

  /** Rename a PR (e.g. to the release version). Idempotent — caller checks diff. */
  async updatePullRequestTitle(prNumber: number, title: string): Promise<void> {
    const headers = await this.headers();
    const url = `${this.opts.repo.apiBase}/repos/${this.opts.repo.destOwner}/${this.destRepo()}/pulls/${prNumber}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`PR title update failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
  }
}

/**
 * Parse a mach `components.yml` the way the workflow's shell does: each
 * `name: <component>` line, with the immediately-preceding `@skipdeploy` comment
 * flagging the next component, and the first following `version:` as its value.
 */
function parseComponents(text: string): {
  ordered: Array<{ name: string; version: string; skip: boolean }>;
  versions: Map<string, string>;
} {
  const lines = text.split(/\r?\n/);
  const ordered: Array<{ name: string; version: string; skip: boolean }> = [];
  const versions = new Map<string, string>();
  let pendingSkip = false;

  const nameRe = /^\s*-?\s*name:\s*(.+?)\s*$/;
  const versionRe = /^\s*-?\s*version:\s*(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('@skipdeploy')) {
      pendingSkip = true;
      continue;
    }
    const nameMatch = line.match(nameRe);
    if (!nameMatch) continue;
    const name = stripQuotes(nameMatch[1]);
    const skip = pendingSkip;
    pendingSkip = false;

    // First `version:` after the name line.
    let version = '';
    for (let j = i + 1; j < lines.length; j++) {
      const vm = lines[j].match(versionRe);
      if (vm) {
        version = stripQuotes(vm[1]);
        break;
      }
      // Stop if we hit the next component before a version.
      if (nameRe.test(lines[j])) break;
    }
    ordered.push({ name, version, skip });
    if (!versions.has(name)) versions.set(name, version);
  }
  return { ordered, versions };
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '').trim();
}

const SEMVER_TOKEN = /v?\d+\.\d+\.\d+[\w.-]*/i;

/**
 * Set a component's version in a `components.yml`, editing only the `version:`
 * line that belongs to `component`. When the existing value carries a semver
 * token (e.g. `@org/web-v4.751.0`), only that token is swapped so any
 * prefix/suffix is preserved; otherwise the whole value is replaced. Returns the
 * new text plus whether anything changed (so callers can stay idempotent).
 */
export function setComponentVersion(
  text: string,
  component: string,
  newVersion: string,
): { text: string; changed: boolean; oldValue?: string; newValue?: string } {
  const lines = text.split(/\r?\n/);
  const nameRe = /^\s*-?\s*name:\s*(.+?)\s*$/;
  const versionRe = /^(\s*-?\s*version:\s*)(.+?)(\s*)$/;
  const numberOnly = newVersion.replace(/^v/i, '');

  for (let i = 0; i < lines.length; i++) {
    const nm = lines[i].match(nameRe);
    if (!nm || stripQuotes(nm[1]) !== component) continue;

    for (let j = i + 1; j < lines.length; j++) {
      if (nameRe.test(lines[j])) break; // next component, no version found
      const vm = lines[j].match(versionRe);
      if (!vm) continue;

      const [, prefix, rawValue, trailing] = vm;
      const oldValue = stripQuotes(rawValue);
      let newValue: string;
      const tok = rawValue.match(SEMVER_TOKEN);
      if (tok) {
        const keepV = /^v/i.test(tok[0]);
        newValue = rawValue.replace(SEMVER_TOKEN, keepV ? `v${numberOnly}` : numberOnly);
      } else {
        newValue = newVersion;
      }
      if (newValue === rawValue) return { text, changed: false, oldValue, newValue: stripQuotes(newValue) };
      lines[j] = `${prefix}${newValue}${trailing}`;
      return { text: lines.join('\n'), changed: true, oldValue, newValue: stripQuotes(newValue) };
    }
    break;
  }
  return { text, changed: false };
}
