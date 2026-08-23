import * as vscode from 'vscode';
import * as path from 'path';
import { MENTION_LIMITS, MentionTarget } from '../../../constants';
import { NamedRoot } from './codebaseTools';

/**
 * Candidate pool pulled from the workspace per keystroke. Generous enough that
 * ranking has something to work with on a large repo, small enough that the
 * picker stays instant — `findFiles` already honors `files.exclude` /
 * `search.exclude`, so node_modules and build output never enter the pool.
 */
const MAX_CANDIDATES = 400;

/** Escapes glob metacharacters so a literal `[` or `{` in the query can't blow up the pattern. */
function escapeGlob(query: string): string {
  return query.replace(/[\\*?[\]{}]/g, '');
}

function displayPathFor(uri: vscode.Uri, roots: NamedRoot[]): string {
  for (const root of roots) {
    const rel = path.relative(root.uri.fsPath, uri.fsPath);
    if (!rel.startsWith('..')) {
      return roots.length > 1 ? `${root.name}/${rel}` : rel;
    }
  }
  return uri.fsPath;
}

/**
 * Ranks a candidate against the typed query. Lower is better; `null` means it
 * doesn't match at all. The ordering encodes what people actually mean when
 * they type a few characters after "@": the file whose NAME starts with them
 * first, then a name containing them, then a path containing them.
 */
function scoreCandidate(displayPath: string, query: string): number | null {
  if (!query) return displayPath.split('/').length; // shallowest paths first
  const lowerPath = displayPath.toLowerCase();
  const lowerName = path.basename(displayPath).toLowerCase();
  const q = query.toLowerCase();

  let base: number;
  if (lowerName === q) base = 0;
  else if (lowerName.startsWith(q)) base = 100;
  else if (lowerName.includes(q)) base = 200;
  else if (lowerPath.includes(q)) base = 300;
  else return null;

  // Tie-break on path depth then length so `src/App.tsx` outranks a
  // same-named file buried six directories deep.
  return base + displayPath.split('/').length * 2 + Math.min(displayPath.length, 80) / 100;
}

/**
 * Resolves what the user has typed after "@" into picker candidates: matching
 * files, plus the directories along their paths that match too (so "@src/comp"
 * can offer the folder itself, not just every file inside it).
 *
 * With an empty query the pool is ordered by modification time, which puts the
 * files the user has been working in at the top of a freshly-opened picker.
 */
export async function searchMentionTargets(
  query: string,
  roots: NamedRoot[]
): Promise<MentionTarget[]> {
  if (!roots.length) return [];

  const cleaned = escapeGlob(query.trim());
  // A query containing "/" is a path fragment — anchor it at a path segment
  // boundary instead of matching it as part of a single file name.
  const pattern = !cleaned
    ? '**/*'
    : cleaned.includes('/')
      ? `**/${cleaned}*`
      : `**/*${cleaned}*`;

  let uris: vscode.Uri[];
  try {
    uris = await vscode.workspace.findFiles(pattern, undefined, MAX_CANDIDATES);
  } catch {
    return [];
  }

  // No name/path hit for a path-fragment query — the fragment may name a
  // directory whose children don't repeat it. Retry against everything under it.
  if (!uris.length && cleaned.includes('/')) {
    try {
      uris = await vscode.workspace.findFiles(`**/${cleaned}*/**/*`, undefined, MAX_CANDIDATES);
    } catch {
      return [];
    }
  }

  if (!cleaned) {
    // Empty query: recency beats any textual score we could compute.
    const withMtime = await Promise.all(
      uris.slice(0, MAX_CANDIDATES).map(async (uri) => {
        try {
          return { uri, mtime: (await vscode.workspace.fs.stat(uri)).mtime };
        } catch {
          return { uri, mtime: 0 };
        }
      })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime);
    return withMtime.slice(0, MENTION_LIMITS.MAX_SUGGESTIONS).map(({ uri }) => {
      const displayPath = displayPathFor(uri, roots);
      return { path: displayPath, name: path.basename(displayPath), kind: 'file' as const };
    });
  }

  const scored: { target: MentionTarget; score: number }[] = [];
  const seenFolders = new Set<string>();

  for (const uri of uris) {
    const displayPath = displayPathFor(uri, roots);
    const fileScore = scoreCandidate(displayPath, cleaned);
    if (fileScore !== null) {
      scored.push({
        target: { path: displayPath, name: path.basename(displayPath), kind: 'file' },
        score: fileScore,
      });
    }

    // Offer the ancestor directories that match the query themselves — a
    // mention of a folder resolves to its listing rather than a file's text.
    const segments = displayPath.split('/');
    for (let i = segments.length - 1; i > 0; i--) {
      const folderPath = segments.slice(0, i).join('/');
      if (seenFolders.has(folderPath)) break;
      seenFolders.add(folderPath);
      const folderScore = scoreCandidate(folderPath, cleaned);
      // Folders rank just behind an equally-good file: mentioning a file is
      // the common case, and a folder only contributes a listing.
      if (folderScore !== null) {
        scored.push({
          target: { path: folderPath, name: segments[i - 1], kind: 'folder' },
          score: folderScore + 50,
        });
      }
    }
  }

  scored.sort((a, b) => a.score - b.score);

  const deduped: MentionTarget[] = [];
  const seenPaths = new Set<string>();
  for (const { target } of scored) {
    if (seenPaths.has(target.path)) continue;
    seenPaths.add(target.path);
    deduped.push(target);
    if (deduped.length >= MENTION_LIMITS.MAX_SUGGESTIONS) break;
  }
  return deduped;
}
