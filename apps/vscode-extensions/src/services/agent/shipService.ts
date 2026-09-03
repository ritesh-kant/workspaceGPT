import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { NamedRoot, resolveAgainstRoots } from '../codebase/codebaseTools';
import { addWorkItemComment } from '../ado/adoWorkItemService';
import { conventionalCommitType, pullRequestUrl, reportToHtml, slugify } from './shipHelpers';

/**
 * "Create PR" after an agent turn: branch, commit ONLY the files the agent
 * changed, push, open the hosting provider's new-PR page pre-filled with the
 * report, and post the acceptance-criteria report back on the ADO ticket.
 *
 * Deliberately uses the user's own `git` and browser session — no token ever
 * passes through the agent, and it works for GitHub, Azure Repos, GitLab and
 * Bitbucket alike because the PR itself is created by the user on the page
 * that opens. The commit lands on a fresh `<type>/…` branch (Conventional
 * Commits type, from the ticket's work item type), never on the branch the
 * user was on.
 */

export interface ShipInput {
  ticketId?: number;
  /** ADO work item type (e.g. "Bug", "Feature", "Task") — picks the branch's Conventional Commits prefix. */
  ticketType?: string;
  /** Ticket title (or the first line of the report) — becomes the commit/PR title. */
  title: string;
  /** The agent's final report, markdown. */
  report: string;
  /** Display paths (possibly root-prefixed) of the files the agent changed. */
  files: string[];
}

export interface ShipResult {
  branch: string;
  baseBranch: string;
  commitSha: string;
  prUrl?: string;
  ticketCommented: boolean;
  warnings: string[];
}

const GIT_TIMEOUT_MS = 60_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout.trim());
    });
  });
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
  const baseBranch = (await git(gitCwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'main';
  if (baseBranch === 'HEAD') throw new Error('HEAD is detached — check out a branch first.');
  if (/^(feat|fix|chore)\//.test(baseBranch)) warnings.push(`Branching from an existing agent branch (${baseBranch}).`);

  const shortTitle = input.title.replace(/\s+/g, ' ').trim().slice(0, 72);
  const commitType = conventionalCommitType(input.ticketType);
  const slug = slugify(input.ticketId ? `${input.ticketId}-${input.title}` : input.title);
  let branch = `${commitType}/${slug}`;
  const existing = await git(gitCwd, ['branch', '--list', branch]);
  if (existing) branch = `${branch}-${Date.now().toString(36).slice(-4)}`;

  onStatus(`Creating branch ${branch}…`);
  await git(gitCwd, ['checkout', '-b', branch]);
  try {
    onStatus(`Committing ${filesFromTop.length} file${filesFromTop.length === 1 ? '' : 's'}…`);
    await git(gitCwd, ['add', '--', ...filesFromTop]);
    const trailer = input.ticketId ? `\n\nAB#${input.ticketId}` : '';
    const message = `${shortTitle}\n\n${input.report.trim()}${trailer}\n\nCo-authored-by: WorkspaceGPT Agent <agent@workspacegpt.dev>`;
    await git(gitCwd, ['commit', '--quiet', '-m', message]);
  } catch (e) {
    // Leave the user where they were rather than on a half-made branch.
    await git(gitCwd, ['checkout', '--quiet', baseBranch]).catch(() => undefined);
    await git(gitCwd, ['branch', '-D', branch]).catch(() => undefined);
    throw e;
  }
  const commitSha = await git(gitCwd, ['rev-parse', 'HEAD']);

  let prUrl: string | undefined;
  const remote = await git(gitCwd, ['remote', 'get-url', 'origin']).catch(() => '');
  if (remote) {
    onStatus(`Pushing ${branch} to origin…`);
    try {
      await git(gitCwd, ['push', '--quiet', '-u', 'origin', branch]);
      prUrl = pullRequestUrl(remote, baseBranch, branch, shortTitle, input.report);
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
      const header = `<p><b>WorkspaceGPT agent run</b> — branch <code>${branch}</code>${prUrl ? ` · <a href="${prUrl}">open pull request</a>` : ''}</p>`;
      await addWorkItemComment(context, input.ticketId, header + reportToHtml(input.report));
      ticketCommented = true;
    } catch (e) {
      warnings.push(`Could not comment on ticket #${input.ticketId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { branch, baseBranch, commitSha, prUrl, ticketCommented, warnings };
}
