import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel Serverless Function: /api/qdrant-search
 *
 * Proxies Qdrant vector search for the Chrome extension so the master Qdrant
 * API key never leaves the server. Clients authenticate with a shared access
 * token (WORKSPACEGPT_ACCESS_TOKEN env var) that can be rotated independently.
 *
 * Accepts:
 *   POST { source: 'CONFLUENCE'|'ADO'|'CODEBASE', vector: number[], topK: number }
 *   Authorization: Bearer <access-token>
 *
 * Returns: { hits: SearchHit[] }
 *
 * Env vars required:
 *   QDRANT_URL                 — e.g. https://xxx.qdrant.io:6333
 *   QDRANT_API_KEY             — master read key (never sent to the client)
 *   WORKSPACEGPT_ACCESS_TOKEN  — shared token distributed to team members
 *   QDRANT_COLLECTION_PREFIX   — optional collection namespace (default: '')
 */

const MANIFEST_ID = 0; // reserved point id — filtered from search results

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const accessToken = process.env.WORKSPACEGPT_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('WORKSPACEGPT_ACCESS_TOKEN not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }
  const authHeader = req.headers['authorization'] ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided || provided !== accessToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantKey = process.env.QDRANT_API_KEY;
  if (!qdrantUrl) {
    console.error('QDRANT_URL not set');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const { source, vector, topK, collectionPrefix = '' } = req.body ?? {};
  if (!source || !Array.isArray(vector) || typeof topK !== 'number') {
    return res.status(400).json({ error: 'Missing required fields: source, vector, topK' });
  }
  if (!['CONFLUENCE', 'ADO', 'CODEBASE'].includes(source)) {
    return res.status(400).json({ error: `Invalid source: ${source}` });
  }

  const collection = `${collectionPrefix}${(source as string).toLowerCase()}`;
  const base = qdrantUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (qdrantKey) headers['api-key'] = qdrantKey;

  try {
    const qdrantRes = await fetch(`${base}/collections/${collection}/points/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        vector,
        limit: topK,
        with_payload: true,
        filter: { must_not: [{ has_id: [MANIFEST_ID] }] },
      }),
    });

    if (!qdrantRes.ok) {
      const detail = await qdrantRes.text().catch(() => '');
      return res.status(502).json({ error: `Qdrant error: ${qdrantRes.status} ${detail}` });
    }

    const json: any = await qdrantRes.json();
    const hits = (json?.result ?? []).map((p: any) => {
      const pl = p.payload ?? {};
      return {
        text: pl.text ?? '',
        score: p.score,
        data: {
          sourceName: pl.sourceName ?? source,
          source: pl.url ?? '',
          fileName: pl.fileName ?? '',
        },
      };
    });

    return res.status(200).json({ hits });
  } catch (err) {
    console.error('qdrant-search proxy error:', err);
    return res.status(500).json({ error: 'Proxy request failed' });
  }
}
