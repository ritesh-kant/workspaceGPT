import type { AuditEntry, AuditLog } from '../types';

/** In-memory audit log — useful for tests and ephemeral runs. */
export class InMemoryAuditLog implements AuditLog {
  private entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async list(release?: string): Promise<AuditEntry[]> {
    return release ? this.entries.filter((e) => e.release === release) : [...this.entries];
  }
}
