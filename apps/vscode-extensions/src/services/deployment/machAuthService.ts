import * as vscode from 'vscode';
import {
  EMPTY_MACH_REPO,
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
    cfg: MachRepoConfig = EMPTY_MACH_REPO,
    brand = '',
    sampleEnv = 'stage',
    machMode = true,
  ): Promise<MachTokenStatus> {
    const token = await this.getToken();
    if (!token) return { connected: false, detail: 'No token set.' };

    // Nothing to probe until the repo topology is configured. Firing requests
    // against blank owner/repo would 404 for a reason that has nothing to do
    // with the token, so don't imply an SSO/auth problem that isn't there.
    // Generic (non-MACH) dispatch only needs the workflow repo, not an env repo.
    const missing = [
      !cfg.monorepoOwner && (machMode ? 'monorepo owner' : 'repo owner'),
      !cfg.monorepoRepo && (machMode ? 'monorepo repo' : 'repo'),
      machMode && !cfg.destOwner && 'env repos owner',
      machMode && !cfg.repoTemplate && 'env repo template',
    ].filter(Boolean);
    if (missing.length) {
      return {
        connected: true,
        detail:
          `Token stored, but the repo topology isn't configured yet ` +
          `(missing: ${missing.join(', ')}). Fill in the Repo topology fields ` +
          `in the Backend stage, then re-test.`,
      };
    }

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

    const monoPath = `${cfg.monorepoOwner}/${cfg.monorepoRepo}`;
    // A representative per-environment repo proves the env org is reachable —
    // MACH mode only. Generic dispatch has no env repo, so it's trivially OK.
    const sampleRepo = machMode ? renderRepoName(cfg.repoTemplate, brand, sampleEnv) : '';
    const stagePath = `${cfg.destOwner}/${sampleRepo}`;
    try {
      const mono = await reach(cfg.monorepoOwner, cfg.monorepoRepo);
      const stage = machMode
        ? await reach(cfg.destOwner, sampleRepo)
        : { ok: true, status: 200 };
      const repos = { monorepo: mono.ok, stage: stage.ok };
      if (mono.ok && stage.ok) return { connected: true, repos };

      const unreachable = [
        !mono.ok ? `${monoPath} (${mono.status})` : null,
        !stage.ok ? `${stagePath} (${stage.status})` : null,
      ].filter(Boolean);
      // Name the actual repo path and status so the failure is diagnosable, and
      // give guidance matched to the status code rather than always blaming SSO.
      const statuses = [mono, stage].filter((r) => !r.ok).map((r) => r.status);
      let hint: string;
      if (statuses.includes(401)) {
        hint = 'A 401 means the token is invalid or expired — regenerate the PAT.';
      } else if (statuses.includes(403)) {
        hint = 'A 403 usually means the PAT is missing the `repo` + `workflow` scopes, or you hit a rate limit.';
      } else if (statuses.includes(404)) {
        hint =
          "A 404 on a private repo means either the PAT isn't SSO-authorized for that org " +
          "(open the token's \"Configure SSO\") or the owner/repo name is wrong — double-check the Repo topology fields.";
      } else {
        hint = 'Verify the Repo topology values and the token scopes.';
      }
      return {
        connected: true,
        repos,
        detail: `Token stored, but can't reach ${unreachable.join(', ')}. ${hint}`,
      };
    } catch (error) {
      return {
        connected: true,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
