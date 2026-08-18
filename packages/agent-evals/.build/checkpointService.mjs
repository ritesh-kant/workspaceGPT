// ../../apps/vscode-extensions/src/services/agent/checkpointService.ts
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
function checkpointServiceFor(globalStorageFsPath, worktree) {
  const hash = createHash("sha256").update(worktree).digest("hex").slice(0, 16);
  const shadowDir = path.join(globalStorageFsPath, "checkpoints", hash);
  return new CheckpointService(shadowDir, worktree);
}
var GIT_TIMEOUT_MS = 6e4;
var CheckpointService = class {
  /**
   * @param shadowGitDir absolute dir for the shadow repo's .git contents,
   *   e.g. `<globalStorage>/checkpoints/<workspace-hash>` — one per workspace.
   * @param worktree the workspace folder being checkpointed.
   */
  constructor(shadowGitDir, worktree) {
    this.shadowGitDir = shadowGitDir;
    this.worktree = worktree;
    this.queue = Promise.resolve();
    this.initialized = false;
  }
  /** Run a git command against the shadow repo. */
  git(args) {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        [`--git-dir=${this.shadowGitDir}`, `--work-tree=${this.worktree}`, ...args],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err)
            reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
          else
            resolve(stdout);
        }
      );
    });
  }
  /** Serialize every public operation — a shared git index is not reentrant. */
  enqueue(op) {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => void 0);
    return next;
  }
  async ensureInit() {
    if (this.initialized)
      return;
    if (!fs.existsSync(path.join(this.shadowGitDir, "HEAD"))) {
      fs.mkdirSync(this.shadowGitDir, { recursive: true });
      await new Promise(
        (resolve, reject) => execFile(
          "git",
          [`--git-dir=${this.shadowGitDir}`, "init", "--quiet"],
          { timeout: GIT_TIMEOUT_MS },
          (err) => err ? reject(err) : resolve()
        )
      );
    }
    await this.git(["config", "user.email", "agent@workspacegpt"]);
    await this.git(["config", "user.name", "WorkspaceGPT Agent"]);
    const exclude = path.join(this.shadowGitDir, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, ".git/\n");
    this.initialized = true;
  }
  /**
   * Snapshot the current working state. Idempotent: if nothing changed since
   * the last checkpoint, returns the existing HEAD instead of an empty commit.
   */
  checkpoint(label) {
    return this.enqueue(async () => {
      await this.ensureInit();
      await this.git(["add", "-A"]);
      const status = await this.git(["status", "--porcelain"]);
      const hasHead = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        (s) => s.trim() !== "",
        () => false
      );
      if (status.trim() === "" && hasHead) {
        const sha2 = (await this.git(["rev-parse", "HEAD"])).trim();
        return { sha: sha2, label, timestamp: Date.now() };
      }
      await this.git(["commit", "--quiet", "--no-verify", "-m", label]);
      const sha = (await this.git(["rev-parse", "HEAD"])).trim();
      await this.git(["tag", "--force", `cp-${sha.slice(0, 12)}`, sha]);
      return { sha, label, timestamp: Date.now() };
    });
  }
  /**
   * Atomically restore the working tree to a checkpoint: modified files are
   * reverted, deleted files restored, and files created since (and tracked by
   * a later checkpoint) removed. Files the shadow repo never tracked are left
   * alone.
   */
  revertTo(sha) {
    return this.enqueue(async () => {
      await this.ensureInit();
      await this.git(["reset", "--hard", "--quiet", sha]);
    });
  }
  /** Most recent first. */
  list(limit = 50) {
    return this.enqueue(async () => {
      await this.ensureInit();
      const hasHead = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        (s) => s.trim() !== "",
        () => false
      );
      if (!hasHead)
        return [];
      const out = await this.git(["log", "--all", `--max-count=${limit}`, "--format=%H%x1f%s%x1f%ct"]);
      return out.trim().split("\n").filter(Boolean).map((line) => {
        const [sha, label, ct] = line.split("");
        return { sha, label, timestamp: Number(ct) * 1e3 };
      });
    });
  }
  /** Files changed between two checkpoints (or a checkpoint and the tree). */
  changedFiles(fromSha, toSha) {
    return this.enqueue(async () => {
      await this.ensureInit();
      const args = ["diff", "--name-status", fromSha, ...toSha ? [toSha] : []];
      const out = await this.git(args);
      const map = { A: "added", M: "modified", D: "deleted", R: "renamed" };
      return out.trim().split("\n").filter(Boolean).map((line) => {
        const [st, ...rest] = line.split("	");
        return { path: rest[rest.length - 1], status: map[st[0]] ?? "modified" };
      });
    });
  }
  /** Unified diff of one file between a checkpoint and the current tree. */
  fileDiff(sha, filePath) {
    return this.enqueue(async () => {
      await this.ensureInit();
      return this.git(["diff", sha, "--", filePath]);
    });
  }
};
export {
  CheckpointService,
  checkpointServiceFor
};
