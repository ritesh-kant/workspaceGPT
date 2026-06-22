import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel Serverless Function: /api/vercel/token
 *
 * Exchanges a Vercel OAuth authorization code for an access token, injecting the
 * integration's client_secret from server-side env so it never ships in the
 * extension bundle. Mirrors the Atlassian token proxy.
 *
 * Accepts:
 *   POST { code: string, redirect_uri: string }
 *
 * Returns Vercel's token payload: { access_token, token_type, installation_id,
 * user_id, team_id }. Note: Vercel integration tokens are long-lived per
 * install (no refresh_token), so there is no refresh grant here.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLIENT_ID = process.env.VERCEL_CLIENT_ID;
  const CLIENT_SECRET = process.env.VERCEL_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing VERCEL_CLIENT_ID or VERCEL_CLIENT_SECRET env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { code, redirect_uri } = req.body ?? {};
  if (!code || !redirect_uri) {
    return res.status(400).json({ error: 'Missing code or redirect_uri' });
  }

  try {
    const response = await fetch('https://api.vercel.com/v2/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri,
      }).toString(),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Vercel token proxy error:', error);
    return res.status(500).json({ error: 'Failed to proxy token request' });
  }
}
