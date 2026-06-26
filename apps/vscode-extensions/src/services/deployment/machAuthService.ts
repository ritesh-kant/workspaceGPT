import * as vscode from 'vscode';
import {
  MARS_MACH_PRESET,
  STORAGE_KEYS,
  renderRepoName,
  type MachRepoConfig,
} from '../../../constants';

export interface MachTokenStatus {
  connected: boolean;
  /** Per-repo reachability from the last validation, when one was run. */
  repos?: { monorepo: boolean; stage: boolean };
  /** Human-readable detail (e.g. SSO/scope error) when validation fails. */
  detail?: string;
}

/**
 * Auth for the mach (backend config) target.
 *
 * Unlike the OAuth providers, mach uses a **classic Personal Access Token** the
 * user creates and SSO-authorizes for both orgs (org admins won't approve an
 * OAuth App for these repos). The PAT needs `repo` + `workflow` scopes and lives
 * in SecretStorage. It is used ONLY for mach API calls and — like all
 * deployment write-creds — is never included in the Chrome share bundle.
 *
 * We never echo the token back to the webview; the UI only ever sees a boolean
 * connected/validated status.
 */
export class MachAuthService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async setToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('Token is empty.');
    await this.context.secrets.store(STORAGE_KEYS.GITHUB_MACH_PAT, trimmed);
  }

  async getToken(): Promise<string | null> {
    return (await this.context.secrets.get(STORAGE_KEYS.GITHUB_MACH_PAT)) ?? null;
  }

  async clear(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.GITHUB_MACH_PAT);
  }

  async isConnected(): Promise<boolean> {
    return (await this.getToken()) !== null;
  }

  /** Token valid for mach API calls; throws if not stored. */
  async requireToken(): Promise<string> {
    const token = await this.getToken();
    if (!token) {
      throw new Error('No mach token set. Add a GitHub PAT in Settings → Deployment Automation.');
    }
    return token;
  }

  /**
   * Confirm the stored PAT can actually reach both mach repos. A classic token
   * that isn't SSO-authorized for an org returns 404 (not 403) on its repos, so
   * a clean 200 on both is the real liveness signal we need before a release.
   */
  async validate(
    cfg: MachRepoConfig = MARS_MACH_PRESET,
    brand = 'mms',
    sampleEnv = 'stage',
  ): Promise<MachTokenStatus> {
    const token = await this.getToken();
    if (!token) return { connected: false, detail: 'No token set.' };

    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'workspacegpt',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const reach = async (owner: string, repo: string): Promise<{ ok: boolean; status: number }> => {
      const res = await fetch(`${cfg.apiBase}/repos/${owner}/${repo}`, { headers });
      return { ok: res.ok, status: res.status };
    };

    // A representative per-environment repo, to prove the env org is reachable.
    const sampleRepo = renderRepoName(cfg.repoTemplate, brand, sampleEnv);
    try {
      const [mono, stage] = await Promise.all([
        reach(cfg.monorepoOwner, cfg.monorepoRepo),
        reach(cfg.destOwner, sampleRepo),
      ]);
      const repos = { monorepo: mono.ok, stage: stage.ok };
      if (mono.ok && stage.ok) return { connected: true, repos };

      // 404 on a private repo a valid token can't see almost always means the
      // PAT isn't SSO-authorized for that org — call it out specifically.
      const unreachable = [
        !mono.ok ? `${cfg.monorepoOwner} (${mono.status})` : null,
        !stage.ok ? `${cfg.destOwner} (${stage.status})` : null,
      ].filter(Boolean);
      return {
        connected: true,
        repos,
        detail:
          `Token stored, but can't reach ${unreachable.join(', ')}. ` +
          `If you see 404, the PAT likely isn't SSO-authorized for that org — ` +
          `open the token's "Configure SSO" and authorize it.`,
      };
    } catch (error) {
      return {
        connected: true,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
