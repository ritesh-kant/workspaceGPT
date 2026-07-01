import { VercelAuthService } from './vercelAuthService';
import type { LlmComplete } from './aiReleaseSource';

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
 * Pull a version string out of a commit message. Every org phrases its release
 * commits differently, so a fixed regex silently mis-extracts (or misses) as
 * soon as the convention drifts. When a chat model is configured (Settings →
 * Model) we ask it to read the message and name the version; regex is only the
 * fallback when no model is set up, or the model call fails/returns nothing
 * plausible — the version-injection feature must keep working either way.
 */
async function extractVersion(commitMessage: string, llm?: LlmComplete): Promise<string | null> {
  if (llm) {
    try {
      const prompt = [
        'A git commit message triggered a deployment. Extract the release version it names.',
        'Different teams format these differently — e.g. "feat(webapp): released version v4.752.1 [no ci]", ' +
          '"chore(release): bump to 4.752.1-rc.2", "Release 2026.7.1", "web-2026-6.2-rc.8".',
        'Return ONLY a JSON object: {"version": <string, the version exactly as it should be recorded ' +
          '(keep a leading "v" only if the message uses one), or null if the message names no version>}.',
        'No markdown, JSON only.',
        '',
        `COMMIT MESSAGE:\n${commitMessage}`,
      ].join('\n');
      const raw = await llm(prompt);
      const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
      const obj = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] ?? cleaned);
      const version = obj?.version != null ? String(obj.version).trim() : '';
      if (version && /\d/.test(version)) return version;
    } catch {
      // Fall through to regex — a flaky/misconfigured model shouldn't block the feature.
    }
  }

  // Prefer "version vX.Y.Z" phrasing; fall back to any semver token.
  const m =
    commitMessage.match(/version\s+v?(\d+\.\d+\.\d+[\w.-]*)/i) ??
    commitMessage.match(/v?(\d+\.\d+\.\d+[\w.-]*)/);
  if (!m) return null;
  const hadV = /version\s+v/i.test(commitMessage) || /\bv\d/.test(commitMessage);
  return hadV ? `v${m[1]}` : m[1];
}

/**
 * Read the version currently deployed to a Vercel environment by taking the
 * latest READY deployment and extracting the version from its git commit
 * message (AI-assisted when a chat model is configured; regex fallback
 * otherwise — see {@link extractVersion}).
 *
 * `envName` is the source environment name (e.g. `test01`); we resolve it to the
 * project's matching custom environment and filter deployments to it.
 */
export async function readVercelDeployedVersion(
  auth: VercelAuthService,
  projectId: string,
  envName: string,
  llm?: LlmComplete,
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
      `No READY deployment matched env "${envName}" ` +
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

  const version = await extractVersion(commitMessage, llm);
  if (!version) {
    throw new Error(
      `Couldn't parse a version from the latest deployment's commit message: "${commitMessage.slice(0, 120)}".`,
    );
  }

  return {
    version,
    commitMessage,
    url: match.inspectorUrl ?? (match.url ? `https://${match.url}` : undefined),
  };
}
