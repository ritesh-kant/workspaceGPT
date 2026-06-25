import { MACH } from '../../../constants';
import { MachAuthService } from './machAuthService';

export interface MachSyncOptions {
  brand: string;
  /** Source environment (e.g. test01) — read from here. */
  from: string;
  /** Destination environment (e.g. stage) — the PR lands here. */
  to: string;
  /** Branch of the source repo to read `components.yml` from. */
  fromBranch: string;
  /** Whether the workflow should also sync `main.yml` env vars. */
  updateMainYml: boolean;
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
export class MachSyncTarget {
  readonly id = 'mach';
  private workflowId?: number;

  constructor(
    private readonly auth: MachAuthService,
    private readonly opts: MachSyncOptions,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    const token = await this.auth.requireToken();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workspacegpt',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** Destination repo name, derived as `aws-<brand>-phoenix-<to>-mach`. */
  private destRepo(): string {
    return MACH.envRepo(this.opts.brand, this.opts.to);
  }

  private srcRepo(): string {
    return MACH.envRepo(this.opts.brand, this.opts.from);
  }

  /** Resolve the workflow's numeric id by its display name (paginated list). */
  private async resolveWorkflowId(): Promise<number> {
    if (this.workflowId) return this.workflowId;
    const headers = await this.headers();
    for (let page = 1; page <= 10; page++) {
      const url = `${MACH.API_BASE}/repos/${MACH.MONOREPO_OWNER}/${MACH.MONOREPO_REPO}/actions/workflows?per_page=100&page=${page}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`Could not list monorepo workflows (${res.status}): ${(await res.text()).slice(0, 200)}`);
      }
      const data: any = await res.json();
      const list: any[] = data?.workflows ?? [];
      const found = list.find((w) => w.name === MACH.WORKFLOW_NAME);
      if (found?.id) {
        this.workflowId = found.id;
        return found.id;
      }
      if (list.length < 100) break; // last page
    }
    throw new Error(`Workflow "${MACH.WORKFLOW_NAME}" not found in ${MACH.MONOREPO_REPO}.`);
  }

  /** Fetch and decode a text file from a repo at a ref (null if absent). */
  private async fetchFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
    const headers = await this.headers();
    const url = `${MACH.API_BASE}/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`;
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
      MACH.MACH_ENV_OWNER,
      this.srcRepo(),
      'components.yml',
      this.opts.fromBranch,
    );
    if (srcText === null) {
      throw new Error(`Source ${this.srcRepo()} has no components.yml on "${this.opts.fromBranch}".`);
    }
    const destText = await this.fetchFile(MACH.MACH_ENV_OWNER, this.destRepo(), 'components.yml', 'main');
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
   * Trigger the sync workflow. Returns immediately after the dispatch is
   * accepted and the new run is located (the PR appears ~5 min later — poll with
   * {@link findPullRequest}). Never auto-merges to stage.
   */
  async triggerSync(sinceIso: string): Promise<MachRunRef> {
    const headers = await this.headers();
    const id = await this.resolveWorkflowId();

    const dispatchUrl = `${MACH.API_BASE}/repos/${MACH.MONOREPO_OWNER}/${MACH.MONOREPO_REPO}/actions/workflows/${id}/dispatches`;
    // stage never auto-merges; force the flag off so it's explicit here too.
    const autoMerge = this.opts.to === 'stage' ? false : false;
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: MACH.MONOREPO_REF,
        inputs: {
          brand: this.opts.brand,
          from: this.opts.from,
          to: this.opts.to,
          from_branch: this.opts.fromBranch,
          auto_merge_pr: String(autoMerge),
          update_main_yml: String(this.opts.updateMainYml),
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`workflow_dispatch failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }

    // Dispatch returns 204 with no run id — find the run we just created.
    const run = await this.findRun(id, sinceIso);
    if (!run) {
      throw new Error('Dispatch accepted, but the run did not appear yet. Check the Actions tab and retry status.');
    }
    return run;
  }

  /** Find the workflow run created on/after `sinceIso` (a few tries, short waits). */
  async findRun(workflowId: number | undefined, sinceIso: string): Promise<MachRunRef | null> {
    const headers = await this.headers();
    const id = workflowId ?? (await this.resolveWorkflowId());
    const since = Date.parse(sinceIso) - 5000; // small buffer for clock skew
    const url = `${MACH.API_BASE}/repos/${MACH.MONOREPO_OWNER}/${MACH.MONOREPO_REPO}/actions/workflows/${id}/runs?event=workflow_dispatch&per_page=10`;
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
    const url = `${MACH.API_BASE}/repos/${MACH.MONOREPO_OWNER}/${MACH.MONOREPO_REPO}/actions/runs/${runId}`;
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
      `${MACH.API_BASE}/repos/${MACH.MACH_ENV_OWNER}/${this.destRepo()}/pulls` +
      `?head=${MACH.MACH_ENV_OWNER}:${encodeURIComponent(branch)}&state=all&per_page=5`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const list: any[] = await res.json();
    const pr = list[0];
    if (!pr) return null;
    return { url: pr.html_url, number: pr.number, state: pr.state, merged: !!pr.merged_at };
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
