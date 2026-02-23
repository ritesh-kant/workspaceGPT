import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Add CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { grant_type, client_id, code, refresh_token, redirect_uri } = req.body;
  const client_secret = process.env.ATLASSIAN_CLIENT_SECRET;

  if (!client_secret) {
    return res.status(500).json({ error: 'Server configuration error: CLIENT_SECRET missing' });
  }

  try {
    const response = await axios.post('https://auth.atlassian.com/oauth/token', {
      grant_type,
      client_id,
      client_secret, // Securely injected here
      code,
      refresh_token,
      redirect_uri,
    }, {
      headers: { 'Accept': 'application/json' }
    });

    return res.status(200).json(response.data);
  } catch (error: any) {
    const statusCode = error.response?.status || 500;
    const errorData = error.response?.data || { error: 'Failed to proxy token request' };
    
    console.error('Atlassian Token Error:', errorData);
    return res.status(statusCode).json(errorData);
  }
}
