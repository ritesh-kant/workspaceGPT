import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Agent checkpoints via a SHADOW GIT REPO (decision: docs/design/coding-agent-roadmap.md
 * open item 2). A separate --git-dir lives under the extension's globalStorage
 * while the user's workspace is the --work-tree, so:
 *
 *  - snapshots capture only the files an approved agent action is about to
 *    change, never the user's entire working tree or unrelated credentials;
 *  - each checkpoint RECORDS the files it was scoped to (a commit trailer),
 *    including files that did not exist yet. A commit's tree is not the
 *    workspace: it holds only what was snapshotted so far, and each file at its
 *    last snapshot. So revert never trusts the tree for a file the checkpoint
 *    did not record. It restores each file recorded at or after the target,
 *    from its earliest such record. It deletes a file only when that record
 *    says the file did not exist yet (the agent created it);
 *  - files no checkpoint since the target recorded (user's own work, files
 *    first snapshotted by an earlier turn) survive reverts;
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

/** Commit-message trailer carrying a checkpoint's scoped files as a JSON array. */
const RECORDED_FILES_TRAILER = 'Checkpoint-Files: ';

export interface RevertResult {
  /** Files written back to their recorded content. */
  restored: string[];
  /** Files removed because the agent created them after the target. */
  removed: string[];
}

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
      // --git-dir is a GLOBAL git flag: it must precede the subcommand.
      // (`git init --git-dir=X` is rejected by git ≥2.x as an unknown option.)
      await new Promise<void>((resolve, reject) =>
        execFile('git', [`--git-dir=${this.shadowGitDir}`, 'init', '--quiet'], { timeout: GIT_TIMEOUT_MS }, (err) =>
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
    fs.writeFileSync(
      exclude,
      [
        '.git/',
        '.env',
        '.env.*',
        '*.pem',
        '*.key',
        '*.p12',
        '*.pfx',
        '*.keystore',
        '*.jks',
        'id_rsa',
        'id_ed25519',
        'id_ecdsa',
        'id_dsa',
        'credentials*.json',
        '.npmrc',
        '.netrc',
        'secret.json',
        'secrets.json',
        'secret.yaml',
        'secrets.yaml',
        'secret.yml',
        'secrets.yml',
        'secret.toml',
        'secrets.toml',
        '',
      ].join('\n'),
    );
    this.initialized = true;
  }

  /**
   * Snapshot the current working state. Idempotent: if nothing changed since
   * the last checkpoint, returns the existing HEAD instead of an empty commit.
   */
  checkpoint(label: string, files: readonly string[], allowEmpty = false): Promise<Checkpoint> {
    return this.enqueue(async () => {
      if (!files.length) {
        throw new Error('A checkpoint requires at least one explicitly scoped file.');
      }
      const scopedFiles = [...new Set(files)].map((file) => {
        const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').some((part) => part === '..')) {
          throw new Error(`Invalid checkpoint path: ${file}`);
        }
        return normalized;
      });
      await this.ensureInit();
      // A file that does not exist yet is recorded as absent: `git add` fails
      // on a path it has never seen, so drop it from the index instead.
      const exists = (file: string) => {
        try {
          fs.lstatSync(path.join(this.worktree, file));
          return true;
        } catch {
          return false;
        }
      };
      const present = scopedFiles.filter(exists);
      const missing = scopedFiles.filter((file) => !exists(file));
      if (present.length) await this.git(['add', '-A', '--', ...present]);
      if (missing.length) {
        await this.git(['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...missing]);
      }
      const hasStagedChanges = await this.git(['diff', '--cached', '--quiet']).then(
        () => false,
        () => true,
      );
      const hasHead = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']).then(
        (s) => s.trim() !== '',
        () => false,
      );
      // Reuse HEAD only when it already recorded these files: an unchanged
      // file that HEAD merely carries is not recorded there.
      if (!hasStagedChanges && hasHead) {
        const recorded = await this.recordedFiles('HEAD');
        if (scopedFiles.every((file) => recorded.includes(file))) {
          const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
          return { sha, label, timestamp: Date.now() };
        }
      }
      if (!hasStagedChanges && !hasHead && !allowEmpty) {
        throw new Error(`No checkpointable change was found for: ${scopedFiles.join(', ')}`);
      }
      await this.git([
        'commit',
        '--quiet',
        '--no-verify',
        '--allow-empty',
        '-m',
        label,
        '-m',
        RECORDED_FILES_TRAILER + JSON.stringify(scopedFiles),
      ]);
      const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
      // Tag every checkpoint: older builds' revertTo() reset HEAD backwards,
      // which would otherwise leave later checkpoints unreachable (invisible
      // to list(), eventually GC-ed) — reverting must never destroy the redo
      // timeline.
      await this.git(['tag', '--force', `cp-${sha.slice(0, 12)}`, sha]);
      return { sha, label, timestamp: Date.now() };
    });
  }

  /**
   * Files a checkpoint recorded. Checkpoints written before the trailer
   * existed fall back to the files that commit changed.
   */
  private async recordedFiles(commit: string): Promise<string[]> {
    const message = await this.git(['log', '-1', '--format=%B', commit]);
    const trailer = message
      .split('\n')
      .reverse()
      .find((line) => line.startsWith(RECORDED_FILES_TRAILER));
    if (trailer) {
      try {
        const files = JSON.parse(trailer.slice(RECORDED_FILES_TRAILER.length));
        if (Array.isArray(files)) return files.filter((file): file is string => typeof file === 'string');
      } catch {
        // Malformed trailer: use the fallback below.
      }
    }
    const changed = await this.git(['diff-tree', '--root', '--no-commit-id', '-r', '--name-only', '-z', commit]);
    return changed.split('\0').filter(Boolean);
  }

  /**
   * Undo everything checkpointed since `sha`: every file recorded by `sha` or
   * a later checkpoint goes back to its earliest such record. A record with
   * the file present restores that content. A record with the file absent
   * means the agent created it, so it is removed. Files no checkpoint since
   * `sha` recorded are left alone. HEAD is not moved, so later checkpoints
   * stay on the timeline (and tagged) for redo.
   */
  revertTo(sha: string): Promise<RevertResult> {
    return this.enqueue(async () => {
      await this.ensureInit();
      const target = (await this.git(['rev-parse', '--verify', `${sha}^{commit}`])).trim();
      const later = (await this.git(['rev-list', '--reverse', '--ancestry-path', `${target}..HEAD`]))
        .split('\n')
        .filter(Boolean);
      const earliest = new Map<string, string>();
      for (const commit of [target, ...later]) {
        for (const file of await this.recordedFiles(commit)) {
          if (!earliest.has(file)) earliest.set(file, commit);
        }
      }
      const restoreFrom = new Map<string, string[]>();
      const removed: string[] = [];
      for (const [file, commit] of earliest) {
        const present = await this.git(['cat-file', '-e', `${commit}:${file}`]).then(
          () => true,
          () => false,
        );
        if (present) restoreFrom.set(commit, [...(restoreFrom.get(commit) ?? []), file]);
        else removed.push(file);
      }
      for (const [commit, files] of restoreFrom) {
        await this.git(['--literal-pathspecs', 'checkout', commit, '--', ...files]);
      }
      if (removed.length) {
        await this.git(['--literal-pathspecs', 'rm', '-f', '--quiet', '--ignore-unmatch', '--', ...removed]);
        for (const file of removed) fs.rmSync(path.join(this.worktree, file), { force: true });
      }
      return { restored: [...restoreFrom.values()].flat(), removed };
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
      // --all: checkpoints stay listed (via their cp-* tags) even after a
      // revert moved HEAD behind them.
      const out = await this.git(['log', '--all', `--max-count=${limit}`, '--format=%H%x1f%s%x1f%ct']);
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
