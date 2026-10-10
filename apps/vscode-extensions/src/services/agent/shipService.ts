import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { NamedRoot, resolveAgainstRoots } from '../codebase/codebaseTools';
import { getActiveTicketProvider } from '../tickets/registry';
import { CodeHostConnections } from '../codehost/connections';
import {
  cutAtWord,
  deriveShipTitle,
  turnCommitType,
  inferConventionalType,
  parseConventionalSubject,
  parsePorcelain,
  pullRequestUrl,
  slugify,
  suggestShipSubject,
} from './shipHelpers';

/**
 * "Create PR" after an agent turn: branch, commit ONLY the files the agent
 * changed, push, open the hosting provider's new-PR page pre-filled with the
 * report, and post the acceptance-criteria report back on the ticket (via
 * whichever tracker is active — see tickets/registry.ts).
 *
 * Deliberately uses the user's own `git` and browser session — no token ever
 * passes through the agent, and it works for GitHub, Azure Repos, GitLab and
 * Bitbucket alike because the PR itself is created by the user on the page
 * that opens. From the default branch the commit lands on a fresh `<type>/…`
 * branch (Conventional Commits type, from the ticket's work item type); from
 * any other branch it lands there. The PR always targets the default branch.
 */

export interface ShipInput {
  ticketId?: string;
  /** The ticket's type (ADO: "Bug"/"Feature"/"Task"; Jira: issue type name) — picks the branch's Conventional Commits prefix. */
  ticketType?: string;
  /** Ticket title (or the first line of the report) — becomes the commit/PR title.
   *  Optional: a turn shipped from the webview's persisted copy has none, and
   *  the report's own heading stands in. */
  title?: string;
  /** The agent's final report, markdown. */
  report: string;
  /** Display paths (possibly root-prefixed) of the files the agent changed. */
  files: string[];
  /** Whether any of those files were created this turn — steers the branch type when no ticket does. */
  hasNewFiles?: boolean;
}

export interface ShipResult {
  branch: string;
  baseBranch: string;
  commitSha: string;
  prUrl?: string;
  /** Whether the branch reached `origin`. False = committed locally only (no remote, or the push failed). */
  pushed: boolean;
  ticketCommented: boolean;
  warnings: string[];
}

const GIT_TIMEOUT_MS = 60_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
      // trimEnd, not trim: porcelain's first line starts with its status
      // column (" M path"), and parsePorcelain reads the path at offset 3.
      else resolve(stdout.trimEnd());
    });
  });
}

/**
 * The plain current branch name, or '' on a detached HEAD.
 *
 * Deliberately NOT `rev-parse --abbrev-ref HEAD`: that returns the
 * *disambiguated* form ("heads/main") whenever the short name could resolve to
 * more than one ref — e.g. a tag sharing the branch's name — and that form
 * then leaks into the status bar, the new branch's name and the PR compare URL.
 */
async function currentBranch(gitCwd: string): Promise<string> {
  return git(gitCwd, ['branch', '--show-current']).catch(() => '');
}

/**
 * The repo's default branch — what a PR should target. `origin/HEAD` when the
 * clone set it, else whichever of main/master exists on origin, else "main".
 */
async function defaultBranch(gitCwd: string): Promise<string> {
  const head = await git(gitCwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
  if (head) return head.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (await git(gitCwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]).catch(() => '')) return name;
  }
  return 'main';
}

export async function shipChanges(
  context: vscode.ExtensionContext,
  roots: NamedRoot[],
  input: ShipInput,
  onStatus: (text: string) => void
): Promise<ShipResult> {
  if (!input.files.length) throw new Error('Nothing to ship — no files were changed this turn.');
  // Every changed file must live in ONE root; commit happens there.
  const first = resolveAgainstRoots(roots, input.files[0]);
  if (!first) throw new Error(`Could not resolve ${input.files[0]} in the workspace.`);
  const root = first.root;
  const cwd = root.uri.fsPath;
  const relFiles: string[] = [];
  for (const f of input.files) {
    const r = resolveAgainstRoots(roots, f);
    if (!r || r.root.uri.fsPath !== cwd) throw new Error(`Changed files span more than one repository (${f}) — ship them separately.`);
    relFiles.push(r.relPath);
  }
  const warnings: string[] = [];

  onStatus('Checking repository state…');
  const repoTop = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`${root.name} is not a git repository.`);
  });
  const gitCwd = repoTop;
  const filesFromTop = relFiles.map((f) => path.relative(gitCwd, path.join(cwd, f)));
  const baseBranch = await currentBranch(gitCwd);
  if (!baseBranch) throw new Error('HEAD is detached — check out a branch first.');
  // PRs target the default branch. Only from the default branch itself do we
  // cut a new one; on any other branch the work is committed there.
  const targetBranch = await defaultBranch(gitCwd);
  const newBranch = baseBranch === targetBranch;

  // The webview's copy of a turn carries no title (AGENT_TURN_SUMMARY never
  // sends one), so the client-payload fallback used after a host restart
  // would otherwise land here as undefined.
  const title = deriveShipTitle(input.title, input.report);
  const shortTitle = cutAtWord(title.replace(/\s+/g, ' ').trim(), 72);
  const commitType = turnCommitType({ ...input, title });
  const slug = slugify(input.ticketId ? `${input.ticketId}-${title}` : title);
  let branch = newBranch ? `${commitType}/${slug}` : baseBranch;
  const existing = newBranch ? await git(gitCwd, ['branch', '--list', branch]) : '';
  if (existing) branch = `${branch}-${Date.now().toString(36).slice(-4)}`;

  // Only one tracker is ever connected (§9): the ticket named in `input`
  // always belongs to whichever one that is.
  const ticketProvider = input.ticketId ? getActiveTicketProvider(context) : null;
  const codeHost = await new CodeHostConnections(context).forRepo(gitCwd).catch(() => null);

  if (newBranch) {
    onStatus(`Creating branch ${branch}…`);
    await git(gitCwd, ['checkout', '-b', branch]);
  }
  try {
    onStatus(`Committing ${filesFromTop.length} file${filesFromTop.length === 1 ? '' : 's'}…`);
    await git(gitCwd, ['add', '--', ...filesFromTop]);
    const trailer = input.ticketId ? `\n\n${ticketProvider?.commitTrailer(input.ticketId) ?? input.ticketId}` : '';
    const message = `${shortTitle}\n\n${input.report.trim()}${trailer}\n\nCo-authored-by: WorkspaceGPT Agent <agent@workspacegpt.dev>`;
    // Pathspec'd: commit these files only, never whatever else sits staged.
    await git(gitCwd, ['commit', '--quiet', '-m', message, '--', ...filesFromTop]);
  } catch (e) {
    // Leave the user where they were rather than on a half-made branch.
    if (newBranch) {
      await git(gitCwd, ['checkout', '--quiet', baseBranch]).catch(() => undefined);
      await git(gitCwd, ['branch', '-D', branch]).catch(() => undefined);
    }
    throw e;
  }
  const commitSha = await git(gitCwd, ['rev-parse', 'HEAD']);

  let prUrl: string | undefined;
  let pushed = false;
  const remote = await git(gitCwd, ['remote', 'get-url', 'origin']).catch(() => '');
  if (remote) {
    onStatus(`Pushing ${branch} to origin…`);
    try {
      await git(gitCwd, ['push', '--quiet', '-u', 'origin', branch]);
      pushed = true;
      prUrl = codeHost
        ? await codeHost.host.createPr(codeHost.repo, { base: targetBranch, head: branch, title: shortTitle, body: input.report }).catch((e) => {
            warnings.push(`Pushed, but could not open the ${codeHost.host.prNoun} on ${codeHost.host.host}: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
          })
        : undefined;
      prUrl ??= pullRequestUrl(remote, targetBranch, branch, shortTitle, input.report);
      if (prUrl) {
        onStatus('Opening the pull-request page…');
        await vscode.env.openExternal(vscode.Uri.parse(prUrl));
      } else {
        warnings.push(`Pushed, but no pull-request URL is known for remote ${remote}; open one manually.`);
      }
    } catch (e) {
      warnings.push(`Committed locally but push failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    warnings.push('No "origin" remote — committed locally only.');
  }

  let ticketCommented = false;
  if (input.ticketId) {
    onStatus(`Posting the report on ticket #${input.ticketId}…`);
    try {
      if (!ticketProvider) throw new Error('No ticket tracker is connected.');
      const header = `**WorkspaceGPT agent run** — branch \`${branch}\`${prUrl ? ` · [open pull request](${prUrl})` : ''}`;
      await ticketProvider.addComment(input.ticketId, `${header}\n\n${input.report.trim()}`);
      ticketCommented = true;
    } catch (e) {
      warnings.push(`Could not comment on ticket #${input.ticketId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { branch, baseBranch: newBranch ? baseBranch : '', commitSha, prUrl, pushed, ticketCommented, warnings };
}

export interface ShipAllResult {
  branch: string;
  baseBranch: string;
  commitSha: string;
  prUrl?: string;
  /** Whether the branch reached `origin` — see ShipResult.pushed. */
  pushed: boolean;
  warnings: string[];
}

/**
 * "Create PR" from the always-on git status bar: branch off HEAD, stage and
 * commit EVERYTHING dirty in the working tree — tracked changes, new files,
 * deletions — push, and open the hosting provider's new-PR page. Unlike
 * `shipChanges`, this isn't scoped to one agent turn or a set of files; it
 * ships whatever is currently uncommitted, agent- or user-made alike.
 *
 * With no ticket to take a title and type from, `askTitle` collects a
 * Conventional Commits subject (pre-filled with one inferred from the changed
 * paths); that subject drives both the commit message and the `<type>/<slug>`
 * branch name. Returns null when the user cancels the prompt.
 */
export async function shipAllChanges(
  roots: NamedRoot[],
  onStatus: (text: string) => void,
  askTitle: (suggestion: string, paths: string[]) => Promise<string | undefined>,
  connections?: CodeHostConnections
): Promise<ShipAllResult | null> {
  if (!roots.length) throw new Error('No workspace folder is open.');
  const cwd = roots[0].uri.fsPath;
  const warnings: string[] = [];

  onStatus('Checking repository state…');
  const gitCwd = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => {
    throw new Error(`${roots[0].name} is not a git repository.`);
  });
  const baseBranch = await currentBranch(gitCwd);
  if (!baseBranch) throw new Error('HEAD is detached — check out a branch first.');
  const targetBranch = await defaultBranch(gitCwd);
  const newBranch = baseBranch === targetBranch;

  // -uall so an untracked directory lands as its files, not one "dir/" entry —
  // the inferred type and subject read the individual paths.
  const dirty = await git(gitCwd, ['status', '--porcelain', '-uall']);
  if (!dirty) throw new Error('Nothing to ship — the working tree is clean.');

  const { paths, hasNewFiles } = parsePorcelain(dirty);
  const inferredType = inferConventionalType(paths, hasNewFiles);
  const answer = await askTitle(`${inferredType}: ${suggestShipSubject(paths, hasNewFiles)}`, paths);
  if (answer === undefined) return null; // cancelled
  const parsed = parseConventionalSubject(answer) ?? { type: inferredType, subject: answer.trim() };
  const commitSubject = `${parsed.type}: ${parsed.subject}`;

  let branch = newBranch ? `${parsed.type}/${slugify(parsed.subject)}` : baseBranch;
  const existing = newBranch ? await git(gitCwd, ['branch', '--list', branch]) : '';
  if (existing) branch = `${branch}-${Date.now().toString(36).slice(-4)}`;

  if (newBranch) {
    onStatus(`Creating branch ${branch}…`);
    await git(gitCwd, ['checkout', '-b', branch]);
  }
  try {
    onStatus('Staging changes…');
    await git(gitCwd, ['add', '-A']);
    await git(gitCwd, ['commit', '--quiet', '-m', commitSubject]);
  } catch (e) {
    if (newBranch) {
      await git(gitCwd, ['checkout', '--quiet', baseBranch]).catch(() => undefined);
      await git(gitCwd, ['branch', '-D', branch]).catch(() => undefined);
    }
    throw e;
  }
  const commitSha = await git(gitCwd, ['rev-parse', 'HEAD']);

  let prUrl: string | undefined;
  let pushed = false;
  const remote = await git(gitCwd, ['remote', 'get-url', 'origin']).catch(() => '');
  if (remote) {
    onStatus(`Pushing ${branch} to origin…`);
    try {
      await git(gitCwd, ['push', '--quiet', '-u', 'origin', branch]);
      pushed = true;
      const codeHost = await connections?.forRepo(gitCwd).catch(() => null);
      prUrl = codeHost
        ? await codeHost.host.createPr(codeHost.repo, { base: targetBranch, head: branch, title: commitSubject, body: '' }).catch((e) => {
            warnings.push(`Pushed, but could not open the ${codeHost.host.prNoun} on ${codeHost.host.host}: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
          })
        : undefined;
      prUrl ??= pullRequestUrl(remote, targetBranch, branch, commitSubject, '');
      if (prUrl) {
        onStatus('Opening the pull-request page…');
        await vscode.env.openExternal(vscode.Uri.parse(prUrl));
      } else {
        warnings.push(`Pushed, but no pull-request URL is known for remote ${remote}; open one manually.`);
      }
    } catch (e) {
      warnings.push(`Committed locally but push failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    warnings.push('No "origin" remote — committed locally only.');
  }

  return { branch, baseBranch: newBranch ? baseBranch : '', commitSha, prUrl, pushed, warnings };
}
