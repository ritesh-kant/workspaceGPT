import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { deleteDirectory } from './deleteDirectory';
import { publishSyncState, SyncSection } from './syncStateStore';

/** Where one Knowledge source keeps its synced markdown (`mds/`) and vector index (`embeddings/`). */
export function sourceDataDir(context: vscode.ExtensionContext, section: SyncSection): string {
  return path.join(context.globalStorageUri.fsPath, section);
}

export interface SourceDataInfo {
  section: SyncSection;
  /** Synced items (one markdown file each). */
  items: number;
  /** Everything stored for the source, markdown and index together. */
  bytes: number;
  path: string;
}

async function walk(dir: string, onFile: (file: string, size: number) => void): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, onFile);
    else if (entry.isFile()) onFile(full, (await fs.stat(full).catch(() => ({ size: 0 }))).size);
  }
}

/** What is stored on this machine for a source. Read-only; nothing here leaves the device. */
export async function describeSourceData(
  context: vscode.ExtensionContext,
  section: SyncSection
): Promise<SourceDataInfo> {
  const dir = sourceDataDir(context, section);
  let items = 0;
  let bytes = 0;
  await walk(dir, (file, size) => {
    bytes += size;
    if (file.endsWith('.md') && file.startsWith(path.join(dir, 'mds'))) items += 1;
  });
  return { section, items, bytes, path: dir };
}

/**
 * Delete a source's synced markdown and index and mark it as never synced,
 * leaving the connection in place. The caller stops the sync and indexing
 * workers first (they hold files open); the next sync downloads it all again.
 */
export async function deleteSourceData(context: vscode.ExtensionContext, section: SyncSection): Promise<void> {
  await deleteDirectory(sourceDataDir(context, section));
  await publishSyncState(context, section, {
    lastSyncTime: '',
    isSyncing: false,
    isIndexing: false,
    isIndexingCompleted: false,
  });
}
