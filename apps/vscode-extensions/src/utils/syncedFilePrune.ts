import * as fs from 'fs';
import * as path from 'path';

/**
 * An incremental sync only fetches what changed since the last run, so an item
 * deleted upstream (or moved out of the synced space/project, or renamed into a
 * new file) never comes back to say so, and its markdown stayed searchable
 * forever. Each sync worker works out which local files no longer have a live
 * source; these helpers are the shared halves: what is on disk, which of it is
 * gone, and deleting it. The next index build reads the md folder, so a deleted
 * file drops out of search with it.
 */

/** A synced markdown file and the source id it was saved from. */
export interface LocalSyncedFile {
  file: string;
  id: string;
}

export function listSyncedFiles(
  mdDir: string,
  idOf: (file: string, mdDir: string) => string | undefined,
): LocalSyncedFile[] {
  let files: string[];
  try {
    files = fs.readdirSync(mdDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: LocalSyncedFile[] = [];
  for (const file of files) {
    const id = idOf(file, mdDir);
    if (id) out.push({ file, id });
  }
  return out;
}

/** ADO and Jira files are named by id: `ADO-123.md` → `123`, `JIRA-ABC-1.md` → `ABC-1`. */
export function idFromFilename(prefix: string) {
  return (file: string): string | undefined =>
    file.startsWith(prefix) && file.endsWith('.md') ? file.slice(prefix.length, -3) || undefined : undefined;
}

/** Confluence files are named by title, so the page id comes from the url in their frontmatter. */
export function confluencePageIdOf(file: string, mdDir: string): string | undefined {
  let head = '';
  try {
    const fd = fs.openSync(path.join(mdDir, file), 'r');
    try {
      const buf = Buffer.alloc(2048);
      head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const url = /^\s*url:\s*(\S+)/m.exec(head)?.[1];
  if (!url) return undefined;
  return /\/pages\/(\d+)/.exec(url)?.[1] ?? /[?&]pageId=(\d+)/.exec(url)?.[1];
}

/**
 * Local Confluence files with no live page behind them under that name: the
 * page is gone from the space, or it was renamed (this sync already wrote it
 * under the new title). An empty listing for a space we hold pages from is far
 * likelier an API or permission hiccup than every page deleted, so it removes
 * nothing; a reconnect still does a clean full sync.
 */
export function goneConfluenceFiles(
  local: readonly LocalSyncedFile[],
  live: ReadonlyArray<{ id: string; filename: string }>,
): string[] {
  if (live.length === 0) return [];
  const expected = new Map(live.map((p) => [p.id, `${p.filename}.md`]));
  return local.filter((l) => expected.get(l.id) !== l.file).map((l) => l.file);
}

/** Deletes the reported files from `mdDir`. Only bare `.md` names inside it; returns how many went. */
export function deleteSyncedFiles(mdDir: string, files: unknown): number {
  if (!Array.isArray(files)) return 0;
  let removed = 0;
  for (const file of files) {
    if (typeof file !== 'string' || path.basename(file) !== file || !file.endsWith('.md')) continue;
    try {
      fs.unlinkSync(path.join(mdDir, file));
      removed++;
    } catch {
      // Already gone — nothing to do.
    }
  }
  return removed;
}
