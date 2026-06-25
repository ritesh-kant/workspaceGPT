import { VercelAuthService } from './vercelAuthService';

export interface VercelDeployedVersion {
  /** The extracted version string, e.g. `v4.752.1`. */
  version: string;
  /** The commit message it was parsed from (for display/audit). */
  commitMessage: string;
  /** Deployment inspector URL, when available. */
  url?: string;
}

const API = 'https://api.vercel.com';

function base(path: string, teamId?: string, extra: Record<string, string> = {}): string {
  const url = new URL(`${API}${path}`);
  if (teamId) url.searchParams.set('teamId', teamId);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return url.toString();
}

/** Resolve a custom environment's {id, slug, name} by slug/name (case-insensitive). */
async function resolveCustomEnv(
  projectId: string,
  envName: string,
  token: string,
  teamId?: string,
): Promise<{ id?: string; slug?: string; name?: string } | null> {
  const res = await fetch(
    base(`/v9/projects/${encodeURIComponent(projectId)}/custom-environments`, teamId),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const data: any = await res.json();
  const list: any[] = data?.environments ?? data?.customEnvironments ?? data?.result ?? [];
  const want = envName.toLowerCase();
  const found = list.find(
    (e) => String(e.slug).toLowerCase() === want || String(e.name).toLowerCase() === want,
  );
  return found ? { id: found.id, slug: found.slug, name: found.name } : null;
}

/**
 * Read the version currently deployed to a Vercel environment by taking the
 * latest READY deployment and parsing its git commit message (e.g.
 * `feat(mms-webapp): released version v4.752.1 [no ci]` → `v4.752.1`).
 *
 * `envName` is the source environment name (e.g. `test01`); we resolve it to the
 * project's matching custom environment and filter deployments to it.
 */
export async function readVercelDeployedVersion(
  auth: VercelAuthService,
  projectId: string,
  envName: string,
): Promise<VercelDeployedVersion> {
  const token = await auth.getValidAccessToken();
  const tokens = await auth.getStoredTokens();
  const teamId = tokens?.teamId;

  const env = await resolveCustomEnv(projectId, envName, token, teamId);

  const res = await fetch(
    base('/v6/deployments', teamId, { projectId, limit: '40' }),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`Vercel deployments read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json();
  const deployments: any[] = data?.deployments ?? [];

  const isReady = (d: any) => String(d.readyState ?? d.state ?? '').toUpperCase() === 'READY';

  // The deployments list uses different fields for custom-env attribution across
  // API versions, so match against every plausible one (id/slug/name/target).
  const want = new Set(
    [envName, env?.id, env?.slug, env?.name]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase()),
  );
  const envIdsOf = (d: any): string[] =>
    [
      d.target,
      d.customEnvironmentId,
      d.customEnvironment?.id,
      d.customEnvironment?.slug,
      d.customEnvironment?.name,
      ...(Array.isArray(d.customEnvironmentIds) ? d.customEnvironmentIds : []),
    ]
      .filter(Boolean)
      .map((s: any) => String(s).toLowerCase());
  const matchesEnv = (d: any) => envIdsOf(d).some((c) => want.has(c));

  // Deployments come newest-first; take the first READY one for this env.
  const match = deployments.find((d) => isReady(d) && matchesEnv(d));

  if (!match) {
    // Diagnostic: surface what env fields the newest deployment actually carries
    // so the mismatch is fixable without guessing.
    const sample = deployments.find(isReady) ?? deployments[0];
    const seen = sample
      ? `target=${JSON.stringify(sample.target)}, customEnvironmentId=${JSON.stringify(
          sample.customEnvironmentId,
        )}, customEnvironment=${JSON.stringify(sample.customEnvironment)}`
      : 'none';
    throw new Error(
      `No READY mms-webapp deployment matched env "${envName}" ` +
        `(resolved id=${env?.id ?? 'n/a'}, slug=${env?.slug ?? 'n/a'}). ` +
        `Newest deployment env fields: ${seen}.`,
    );
  }

  const commitMessage: string =
    match.meta?.githubCommitMessage ??
    match.meta?.gitlabCommitMessage ??
    match.meta?.bitbucketCommitMessage ??
    match.meta?.gitCommitMessage ??
    '';

  // Prefer "version vX.Y.Z" phrasing; fall back to any semver token.
  const m =
    commitMessage.match(/version\s+v?(\d+\.\d+\.\d+[\w.-]*)/i) ??
    commitMessage.match(/v?(\d+\.\d+\.\d+[\w.-]*)/);
  if (!m) {
    throw new Error(
      `Couldn't parse a version from the latest deployment's commit message: "${commitMessage.slice(0, 120)}".`,
    );
  }

  // Keep the leading `v` if the message used one.
  const hadV = /version\s+v/i.test(commitMessage) || /\bv\d/.test(commitMessage);
  return {
    version: hadV ? `v${m[1]}` : m[1],
    commitMessage,
    url: match.inspectorUrl ?? (match.url ? `https://${match.url}` : undefined),
  };
}
