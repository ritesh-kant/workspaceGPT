import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel Serverless Function: /api/github/oauth-token
 *
 * Exchanges a GitHub OAuth authorization code for a user access token (and
 * refreshes it, if the OAuth App has token expiration enabled), injecting the
 * client_secret from server-side env so it never ships in the extension bundle.
 * Mirrors the Atlassian token proxy.
 *
 * Accepts:
 *   POST { grant_type: 'authorization_code', code, redirect_uri }
 *   POST { grant_type: 'refresh_token', refresh_token }
 *
 * Returns GitHub's token payload (JSON): { access_token, token_type, scope,
 * and — when expiration is enabled — refresh_token, expires_in,
 * refresh_token_expires_in }.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
  const CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_SECRET env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { grant_type, code, redirect_uri, refresh_token } = req.body ?? {};
  if (!grant_type) return res.status(400).json({ error: 'Missing grant_type' });

  const payload: Record<string, string> = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type,
  };

  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: 'Missing code or redirect_uri' });
    }
    payload.code = code;
    payload.redirect_uri = redirect_uri;
  } else if (grant_type === 'refresh_token') {
    if (!refresh_token) return res.status(400).json({ error: 'Missing refresh_token' });
    payload.refresh_token = refresh_token;
  } else {
    return res.status(400).json({ error: `Unsupported grant_type: ${grant_type}` });
  }

  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    // GitHub returns HTTP 200 with an `error` field for OAuth failures (e.g.
    // bad_verification_code), so surface that as a 400 rather than a false 200.
    if (!response.ok || data.error) {
      return res.status(response.ok ? 400 : response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('GitHub OAuth token proxy error:', error);
    return res.status(500).json({ error: 'Failed to proxy token request' });
  }
}
