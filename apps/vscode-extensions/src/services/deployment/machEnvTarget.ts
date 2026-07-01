import type { ApplyResult, ConfigTarget, ConfigVarDiff, Environment } from '@workspace-gpt/release-core';
import { MachSyncTarget, type MachPullRef } from './machSyncTarget';

/**
 * Parse/serialize the env-var half of mach `main.yml`. The exact schema is
 * org-specific (open item #1 in DEPLOYMENT-AUTOMATION-DESIGN.md), so it's
 * injected rather than baked into the target — swapping YAML layouts (or moving
 * to Doppler/Parameter-Store) is a codec change, not an engine change.
 */
export interface MainYmlCodec {
  /** Extract env vars as a name→value map from `main.yml` text. */
  parse(text: string): Map<string, string>;
  /**
   * Return `main.yml` text with `key` set to `value`, editing only that entry.
   * `changed` is false when the value already matched — this is what keeps
   * {@link MachEnvTarget.apply} idempotent (a satisfied plan produces no commit).
   */
  set(text: string, key: string, value: string): { text: string; changed: boolean };
}

export interface MachEnvTargetOptions {
  /** Path to the env-var file inside the destination repo. Default `main.yml`. */
  filePath?: string;
  /** Parser/serializer for that file's env-var schema. */
  codec: MainYmlCodec;
}

/** Thrown by {@link MachEnvTarget.readCurrent} when no open sync PR exists. */
export class NoSyncPrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSyncPrError';
  }
}

/**
 * `ConfigTarget` for mach backend env vars living in `main.yml`.
 *
 * The critical difference from {@link VercelTarget}: "current" is **not** the
 * destination repo's default branch. The sync workflow opens a release PR
 * (branch `sync-from-<from>-to-<to>-<run_id>`) carrying the latest
 * `components.yml` + `main.yml`, and that PR head is the state we diff against.
 * So {@link readCurrent} reads `main.yml` at the PR head, and {@link apply}
 * commits corrections back to the *same* PR branch (never a competing PR) — the
 * PR stays the single review + merge gate.
 *
 * This inverts Vercel's order: Vercel diffs live then writes; mach needs the
 * sync PR to exist *before* it can diff. With none open, {@link readCurrent}
 * throws {@link NoSyncPrError} so the UI can prompt "run mach sync first" rather
 * than mis-diffing every var as an `add` against `main`.
 *
 * Shares the `mach` target id with {@link MachSyncTarget}: two facets of one
 * backend target — component versions (workflow-driven) and env vars (this).
 */
export class MachEnvTarget implements ConfigTarget {
  readonly id = 'mach';
  private pr?: MachPullRef & { headBranch: string };

  constructor(
    private readonly sync: MachSyncTarget,
    private readonly opts: MachEnvTargetOptions,
  ) {}

  private filePath(): string {
    return this.opts.filePath ?? 'main.yml';
  }

  /** Resolve (and cache) the latest open sync PR + its head branch. */
  private async resolvePr(): Promise<MachPullRef & { headBranch: string }> {
    if (this.pr) return this.pr;
    const found = await this.sync.findLatestSyncPull();
    if (!found) {
      throw new NoSyncPrError(
        'No open mach sync PR found. Run "Plan mach sync" to open the release PR, ' +
          'then diff env vars against it.',
      );
    }
    this.pr = found;
    return found;
  }

  /** The PR being diffed against / committed to — for surfacing its URL in the UI. */
  async pullRequest(): Promise<MachPullRef> {
    return this.resolvePr();
  }

  /**
   * Env vars as they stand in `main.yml` at the sync PR head. An absent file on
   * the PR branch yields an empty map (every desired var classifies as `add`);
   * an absent PR throws {@link NoSyncPrError}, which is distinct from "PR exists
   * but the file is empty" and must not be conflated with it.
   */
  async readCurrent(_environment: Environment): Promise<Map<string, string>> {
    const pr = await this.resolvePr();
    const file = await this.sync.readDestFile(pr.headBranch, this.filePath());
    if (!file) return new Map();
    return this.opts.codec.parse(file.content);
  }

  /**
   * Apply add/update rows by editing `main.yml` on the sync PR branch. Reads the
   * file once, applies every change in memory, then commits a single time — so N
   * vars become one commit and the blob sha stays valid. Idempotent: rows already
   * at the desired value produce no commit. The PR updates itself; every result
   * references the PR URL. The engine filters match/conflict out before calling,
   * so this never silently overwrites a conflict.
   */
  async apply(_environment: Environment, changes: ConfigVarDiff[]): Promise<ApplyResult[]> {
    const pr = await this.resolvePr();
    const file = await this.sync.readDestFile(pr.headBranch, this.filePath());
    if (!file) {
      return changes.map((c) => ({
        key: c.key,
        target: this.id,
        status: 'failed' as const,
        error: `${this.filePath()} not found on PR branch ${pr.headBranch}`,
        reference: pr.url,
      }));
    }

    // Apply every row in memory first, so N vars collapse into a single commit.
    let text = file.content;
    const changed = new Set<string>();
    for (const c of changes) {
      const next = this.opts.codec.set(text, c.key, c.desired);
      if (next.changed) {
        text = next.text;
        changed.add(c.key);
      }
    }

    // Idempotent: re-running a satisfied plan touches nothing.
    if (changed.size === 0) {
      return changes.map((c) => ({ key: c.key, target: this.id, status: 'applied' as const, reference: pr.url }));
    }

    try {
      await this.sync.commitDestFile(
        pr.headBranch,
        this.filePath(),
        text,
        file.sha,
        `chore(release): reconcile ${this.filePath()} env vars (${[...changed].join(', ')})`,
      );
    } catch (error) {
      // The commit is all-or-nothing, so a failure means nothing landed.
      const msg = error instanceof Error ? error.message : String(error);
      return changes.map((c) => ({
        key: c.key,
        target: this.id,
        status: 'failed' as const,
        error: msg,
        reference: pr.url,
      }));
    }
    return changes.map((c) => ({ key: c.key, target: this.id, status: 'applied' as const, reference: pr.url }));
  }
}
