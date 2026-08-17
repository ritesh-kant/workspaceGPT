import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Agent checkpoints via a SHADOW GIT REPO (decision: CODING-AGENT-ROADMAP.md
 * open item 2). A separate --git-dir lives under the extension's globalStorage
 * while the user's workspace is the --work-tree, so:
 *
 *  - snapshots capture the user's *uncommitted* working state, not HEAD;
 *  - revert is one atomic `reset --hard` across modified/created/deleted files;
 *  - files the shadow repo never tracked (user's untracked work created after
 *    the last checkpoint) survive reverts;
 *  - the user's real .git — index, HEAD, reflog, status — is never touched;
 *  - the workspace's own .gitignore is respected automatically (gitignore is
 *    worktree-level), so node_modules etc. stay out of snapshots.
 *
 * All operations are serialized on an internal queue: two concurrent `git add`
 * runs against one index file corrupt it, and the agent loop can fire
 * checkpoint() while the UI asks for list().
 */

export interface Checkpoint {
  sha: string;
  label: string;
  /** Unix ms. */
  timestamp: number;
}

/**
 * One canonical mapping workspace → shadow-repo location, shared by the chat
 * service (writes checkpoints) and the revert command (reads them), so both
 * always address the same shadow repo.
 */
export function checkpointServiceFor(globalStorageFsPath: string, worktree: string): CheckpointService {
  const hash = createHash('sha256').update(worktree).digest('hex').slice(0, 16);
  const shadowDir = path.join(globalStorageFsPath, 'checkpoints', hash);
  return new CheckpointService(shadowDir, worktree);
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

const GIT_TIMEOUT_MS = 60_000;

export class CheckpointService {
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;

  /**
   * @param shadowGitDir absolute dir for the shadow repo's .git contents,
   *   e.g. `<globalStorage>/checkpoints/<workspace-hash>` — one per workspace.
   * @param worktree the workspace folder being checkpointed.
   */
  constructor(
    private readonly shadowGitDir: string,
    private readonly worktree: string,
  ) {}

  /** Run a git command against the shadow repo. */
  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        [`--git-dir=${this.shadowGitDir}`, `--work-tree=${this.worktree}`, ...args],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
          else resolve(stdout);
        },
      );
    });
  }

  /** Serialize every public operation — a shared git index is not reentrant. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (!fs.existsSync(path.join(this.shadowGitDir, 'HEAD'))) {
      fs.mkdirSync(this.shadowGitDir, { recursive: true });
      await new Promise<void>((resolve, reject) =>
        execFile('git', ['init', '--quiet', `--git-dir=${this.shadowGitDir}`], { timeout: GIT_TIMEOUT_MS }, (err) =>
          err ? reject(err) : resolve(),
        ),
      );
    }
    // Identity local to the shadow repo — never rely on (or pollute) the
    // user's git config; commits here are plumbing, not authorship.
    await this.git(['config', 'user.email', 'agent@workspacegpt']);
    await this.git(['config', 'user.name', 'WorkspaceGPT Agent']);
    // Never snapshot the user's real repo metadata.
    const exclude = path.join(this.shadowGitDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, '.git/\n');
    this.initialized = true;
  }

  /**
   * Snapshot the current working state. Idempotent: if nothing changed since
   * the last checkpoint, returns the existing HEAD instead of an empty commit.
   */
  checkpoint(label: string): Promise<Checkpoint> {
    return this.enqueue(async () => {
      await this.ensureInit();
      await this.git(['add', '-A']);
      const status = await this.git(['status', '--porcelain']);
      const hasHead = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
        (s) => s.trim() !== '',
        () => false,
      );
      if (status.trim() === '' && hasHead) {
        const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
        return { sha, label, timestamp: Date.now() };
      }
      await this.git(['commit', '--quiet', '--no-verify', '-m', label]);
      const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
      return { sha, label, timestamp: Date.now() };
    });
  }

  /**
   * Atomically restore the working tree to a checkpoint: modified files are
   * reverted, deleted files restored, and files created since (and tracked by
   * a later checkpoint) removed. Files the shadow repo never tracked are left
   * alone.
   */
  revertTo(sha: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInit();
      await this.git(['reset', '--hard', '--quiet', sha]);
    });
  }

  /** Most recent first. */
  list(limit = 50): Promise<Checkpoint[]> {
    return this.enqueue(async () => {
      await this.ensureInit();
      const hasHead = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
        (s) => s.trim() !== '',
        () => false,
      );
      if (!hasHead) return [];
      const out = await this.git(['log', `--max-count=${limit}`, '--format=%H%x1f%s%x1f%ct']);
      return out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, label, ct] = line.split('\x1f');
          return { sha, label, timestamp: Number(ct) * 1000 };
        });
    });
  }

  /** Files changed between two checkpoints (or a checkpoint and the tree). */
  changedFiles(fromSha: string, toSha?: string): Promise<ChangedFile[]> {
    return this.enqueue(async () => {
      await this.ensureInit();
      const args = ['diff', '--name-status', fromSha, ...(toSha ? [toSha] : [])];
      const out = await this.git(args);
      const map: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
      return out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [st, ...rest] = line.split('\t');
          return { path: rest[rest.length - 1], status: map[st[0]] ?? 'modified' };
        });
    });
  }

  /** Unified diff of one file between a checkpoint and the current tree. */
  fileDiff(sha: string, filePath: string): Promise<string> {
    return this.enqueue(async () => {
      await this.ensureInit();
      return this.git(['diff', sha, '--', filePath]);
    });
  }
}
