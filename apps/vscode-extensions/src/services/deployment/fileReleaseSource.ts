import type {
  ReleaseSource,
  ResolvedRelease,
  DesiredConfigVar,
  Environment,
} from '@workspace-gpt/release-core';
import { MachAuthService } from './machAuthService';
import { normalizeDate } from './confluenceReleaseSource';

export interface FileReleaseSourceOptions {
  apiBase: string;
  owner: string;
  repo: string;
  /** Path to the JSON release spec in the repo, e.g. `releases.json`. */
  path: string;
  ref: string;
}

/**
 * A `ReleaseSource` backed by a JSON release spec committed to a Git repo —
 * a structurally different source from Confluence, proving the seam is real for
 * orgs that don't keep release info on a wiki. Read via the GitHub contents API
 * with the mach PAT (no extra auth).
 *
 * Expected shape (dependency-free JSON, no YAML lib needed):
 *   {
 *     "releases": [
 *       { "date": "2026-06-26", "version": "1.2.3", "environment": "stage",
 *         "pilot": "Jane",
 *         "config": [
 *           { "key": "FEATURE_X", "value": "true", "target": "vercel" },
 *           { "key": "API_URL", "values": { "stage": "...", "prod": "..." }, "target": "mach" }
 *         ] }
 *     ]
 *   }
 */
export class FileReleaseSource implements ReleaseSource {
  constructor(
    private readonly auth: MachAuthService,
    private readonly opts: FileReleaseSourceOptions,
  ) {}

  private async fetchSpec(): Promise<any> {
    const { apiBase, owner, repo, path, ref } = this.opts;
    if (!owner || !repo || !path) {
      throw new Error('Set the release file repo, owner and path in Settings → Deployment.');
    }
    const token = await this.auth.requireToken();
    const url = `${apiBase}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref || 'main')}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'workspacegpt',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`Read ${owner}/${repo}/${path} failed (${res.status}): ${(await res.text()).slice(0, 150)}`);
    }
    const data: any = await res.json();
    const text = Buffer.from(data?.content ?? '', data?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Release file ${path} is not valid JSON.`);
    }
  }

  private releases(spec: any): any[] {
    return Array.isArray(spec?.releases) ? spec.releases : Array.isArray(spec) ? spec : [];
  }

  async resolveRelease(date: string): Promise<ResolvedRelease | null> {
    const spec = await this.fetchSpec();
    const row = this.releases(spec).find((r) => normalizeDate(String(r?.date ?? '')) === date);
    if (!row || !row.version) return null;
    const rawEnv = String(row.environment ?? '').toLowerCase();
    const environment: Environment =
      /pr(o)?d|production/.test(rawEnv) ? 'prod' : /stag/.test(rawEnv) ? 'stage' : row.environment || 'stage';
    return {
      version: String(row.version),
      environment,
      pilot: row.pilot ? String(row.pilot) : undefined,
      date,
    };
  }

  async fetchDesiredConfig(version: string, environment: Environment): Promise<DesiredConfigVar[]> {
    const spec = await this.fetchSpec();
    const base = version.replace(/-rc\.?\d+$/i, '').trim() || version;
    const row =
      this.releases(spec).find((r) => String(r?.version) === version) ??
      this.releases(spec).find((r) => String(r?.version) === base);
    if (!row) {
      throw new Error(`No release entry for "${version}" in the release file.`);
    }
    const out: DesiredConfigVar[] = [];
    for (const c of Array.isArray(row.config) ? row.config : []) {
      const key = c?.key ? String(c.key).trim() : '';
      if (!key) continue;
      let value = c?.value;
      if (c?.values && typeof c.values === 'object') value = c.values[environment] ?? value;
      if (value == null) continue;
      out.push({
        key,
        value: String(value),
        target: c?.target === 'vercel' ? 'vercel' : 'mach',
        sensitive: !!c?.sensitive,
        note: c?.note ? String(c.note) : undefined,
      });
    }
    return out;
  }
}
