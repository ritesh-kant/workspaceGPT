import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEntry, AuditLog } from '../types';

/**
 * Append-only audit log backed by a JSONL file (one entry per line). Append is
 * the only mutation — entries are never edited or removed.
 */
export class FileAuditLog implements AuditLog {
  constructor(private readonly filePath: string) {}

  async record(entry: AuditEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
  }

  async list(release?: string): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEntry);
    return release ? entries.filter((e) => e.release === release) : entries;
  }
}
