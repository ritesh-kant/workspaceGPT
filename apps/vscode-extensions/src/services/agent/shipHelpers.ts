/**
 * Pure helpers for shipService — no vscode / auth imports, so the headless
 * eval harness can unit-test them without bundling the Azure auth stack.
 */

/** Commit/PR title: the ticket's own title, else the answer's first heading, else a fallback. */
export function deriveShipTitle(ticketTitle: string | undefined, report: string): string {
  return (
    ticketTitle ||
    report
      .split('\n')
      .find((l) => /^##\s/.test(l))
      ?.replace(/^##\s*/, '')
      .replace(/^[^\w`]+/, '') ||
    'Agent changes'
  );
}

/** ADO work item type (e.g. "Bug", "User Story", "Feature", "Task") → Conventional Commits branch type. */
export function conventionalCommitType(ticketType?: string): 'fix' | 'feat' | 'chore' {
  const t = (ticketType || '').toLowerCase();
  if (/bug|defect/.test(t)) return 'fix';
  if (/feature|story|epic|enhancement/.test(t)) return 'feat';
  return 'chore';
}

export function slugify(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '') || 'agent-change';
}

/** Hosting provider's "open a PR for this branch" URL, pre-filled where the provider supports it. */
export function pullRequestUrl(remoteUrl: string, base: string, branch: string, title: string, body: string): string | undefined {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!m) return undefined;
  const host = m[1];
  const repoPath = m[2];
  const q = (s: string) => encodeURIComponent(s);
  // GitHub's URL length limit is ~8k; keep the body well under it.
  const shortBody = body.length > 4000 ? body.slice(0, 4000) + '\n\n… (report truncated — full report is in the commit message)' : body;
  if (/github\.com$/.test(host)) {
    return `https://${host}/${repoPath}/compare/${q(base)}...${q(branch)}?expand=1&title=${q(title)}&body=${q(shortBody)}`;
  }
  if (/dev\.azure\.com$/.test(host) || /visualstudio\.com$/.test(host)) {
    // ssh form: v3/org/project/repo ; https form: org/project/_git/repo
    const parts = repoPath.replace(/^v3\//, '').split('/');
    const httpsPath = parts.includes('_git') ? repoPath : `${parts[0]}/${parts[1]}/_git/${parts[2]}`;
    return `https://dev.azure.com/${httpsPath}/pullrequestcreate?sourceRef=${q(branch)}&targetRef=${q(base)}`;
  }
  if (/gitlab/.test(host)) {
    return `https://${host}/${repoPath}/-/merge_requests/new?merge_request[source_branch]=${q(branch)}&merge_request[target_branch]=${q(base)}&merge_request[title]=${q(title)}`;
  }
  if (/bitbucket\.org$/.test(host)) {
    return `https://${host}/${repoPath}/pull-requests/new?source=${q(branch)}&dest=${q(base)}`;
  }
  return undefined;
}

/** Markdown → the small HTML subset ADO comments render (paragraphs, code, bold, tables as preformatted). */
export function reportToHtml(markdown: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out: string[] = [];
  let table: string[] = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
    out.push('<table style="border-collapse:collapse">');
    rows.forEach((r, i) => {
      const cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      out.push('<tr>' + cells.map((c) => `<${tag} style="border:1px solid #ccc;padding:4px 8px;text-align:left">${inline(c)}</${tag}>`).join('') + '</tr>');
    });
    out.push('</table>');
    table = [];
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    if (/^\s*\|/.test(line)) {
      table.push(line);
      continue;
    }
    flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length + 1, 4);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    } else if (/^\s*[-*]\s+/.test(line)) {
      out.push(`<div>• ${inline(line.replace(/^\s*[-*]\s+/, ''))}</div>`);
    } else if (line.trim()) {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flushTable();
  return out.join('\n');
}
