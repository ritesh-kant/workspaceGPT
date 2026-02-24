import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel Serverless Function: /api/token
 *
 * Proxies OAuth token requests to Atlassian, injecting the client_secret
 * from server-side environment variables so it never leaves the server.
 *
 * Accepts:
 *   POST { grant_type: 'authorization_code', code, redirect_uri }
 *   POST { grant_type: 'refresh_token', refresh_token }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const CLIENT_ID = process.env.ATLASSIAN_CLIENT_ID;
  const CLIENT_SECRET = process.env.ATLASSIAN_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing ATLASSIAN_CLIENT_ID or ATLASSIAN_CLIENT_SECRET env vars');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { grant_type, code, redirect_uri, refresh_token } = req.body;

  if (!grant_type) {
    return res.status(400).json({ error: 'Missing grant_type' });
  }

  // Build the payload for Atlassian
  let payload: Record<string, string> = {
    grant_type,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  };

  if (grant_type === 'authorization_code') {
    if (!code || !redirect_uri) {
      return res.status(400).json({ error: 'Missing code or redirect_uri' });
    }
    payload.code = code;
    payload.redirect_uri = redirect_uri;
  } else if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return res.status(400).json({ error: 'Missing refresh_token' });
    }
    payload.refresh_token = refresh_token;
  } else {
    return res.status(400).json({ error: `Unsupported grant_type: ${grant_type}` });
  }

  try {
    const response = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Token proxy error:', error);
    return res.status(500).json({ error: 'Failed to proxy token request' });
  }
}
