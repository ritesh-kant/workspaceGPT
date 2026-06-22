import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'node:crypto';

/**
 * Vercel Serverless Function: /api/github/installation-token
 *
 * Mints a short-lived (≈1 hour) GitHub App *installation token* scoped to the
 * repositories the App was installed on. The App's private key never leaves the
 * server: VS Code only ever receives the minted token.
 *
 * Flow:
 *   1. Sign a short app JWT (RS256) with GITHUB_APP_PRIVATE_KEY.
 *   2. Exchange it for an installation token via the GitHub API.
 *
 * Accepts:
 *   POST { installation_id: string, repositories?: string[], permissions?: object }
 *
 * `repositories` / `permissions` let the caller request a *narrower* token than
 * the installation grants (least privilege); both are optional.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const APP_ID = process.env.GITHUB_APP_ID;
  const RAW_KEY = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!APP_ID || !RAW_KEY) {
    console.error('Missing GITHUB_APP_ID or GITHUB_APP_PRIVATE_KEY env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { installation_id, repositories, permissions } = req.body ?? {};
  if (!installation_id) {
    return res.status(400).json({ error: 'Missing installation_id' });
  }

  // The PEM may be stored base64-encoded (to survive single-line env vars) or raw.
  const privateKey = RAW_KEY.includes('BEGIN')
    ? RAW_KEY
    : Buffer.from(RAW_KEY, 'base64').toString('utf8');

  try {
    const jwt = makeAppJwt(APP_ID, privateKey);

    const body: Record<string, unknown> = {};
    if (Array.isArray(repositories) && repositories.length > 0) body.repositories = repositories;
    if (permissions && typeof permissions === 'object') body.permissions = permissions;

    const response = await fetch(
      `https://api.github.com/app/installations/${encodeURIComponent(String(installation_id))}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'workspacegpt-auth-proxy',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // { token, expires_at, permissions, repository_selection }
    return res.status(200).json(data);
  } catch (error) {
    console.error('GitHub installation-token error:', error);
    return res.status(500).json({ error: 'Failed to mint installation token' });
  }
}

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/** Build a signed GitHub App JWT (RS256), valid for ~9 minutes. */
function makeAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // iat backdated 60s to tolerate clock skew; exp well under GitHub's 10-min max.
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString('base64url');

  return `${signingInput}.${signature}`;
}
