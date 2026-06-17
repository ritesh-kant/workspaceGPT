import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Vercel Serverless Function: /api/search
 *
 * Server-side RAG retrieval: embeds the text query with Gemini, then searches
 * Qdrant. The Chrome extension in team mode only sends plain text — no Gemini
 * key, no Qdrant key, no vector math needed on the client.
 *
 * Accepts:
 *   POST { sources: ('CONFLUENCE'|'ADO'|'CODEBASE')[], query: string, topK?: number }
 *   Authorization: Bearer <access-token>
 *
 * Returns: { hits: SearchHit[] }  (sorted by score desc, deduplicated across sources)
 *
 * Env vars required:
 *   GEMINI_API_KEY             — embeds the query server-side
 *   QDRANT_URL                 — e.g. https://xxx.qdrant.io:6333
 *   QDRANT_API_KEY             — master read key
 *   WORKSPACEGPT_ACCESS_TOKEN  — shared token distributed to team members
 *   QDRANT_COLLECTION_PREFIX   — optional collection namespace (default: '')
 */

const MANIFEST_ID = 0;
const GEMINI_MODEL = 'models/gemini-embedding-001';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const EMBED_DIMS = 768;
const DEFAULT_TOP_K = 8;
const VALID_SOURCES = new Set(['CONFLUENCE', 'ADO', 'CODEBASE']);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const accessToken = process.env.WORKSPACEGPT_ACCESS_TOKEN;
  if (!accessToken) return res.status(500).json({ error: 'Server misconfigured' });
  const authHeader = req.headers['authorization'] ?? '';
  const provided = authHeader.startsWith('Bearer ') ? (authHeader as string).slice(7) : '';
  if (!provided || provided !== accessToken) return res.status(401).json({ error: 'Unauthorized' });

  const geminiKey = process.env.GEMINI_API_KEY;
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantKey = process.env.QDRANT_API_KEY;
  if (!geminiKey || !qdrantUrl) return res.status(500).json({ error: 'Server misconfigured' });

  const { sources, query, topK = DEFAULT_TOP_K, collectionPrefix = '' } = req.body ?? {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Missing required field: query' });
  }
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s: unknown) => VALID_SOURCES.has(s as string))) {
    return res.status(400).json({ error: 'sources must be a non-empty array of CONFLUENCE|ADO|CODEBASE' });
  }

  // 1. Embed query server-side
  let queryVector: number[];
  try {
    queryVector = await embedQuery(query.slice(0, 7500), geminiKey);
  } catch (err: any) {
    console.error('Gemini embed error:', err);
    return res.status(502).json({ error: `Embedding failed: ${err.message}` });
  }

  // 2. Search each source in parallel
  const base = qdrantUrl.replace(/\/+$/, '');
  const qdrantHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (qdrantKey) qdrantHeaders['api-key'] = qdrantKey;

  const perSource = await Promise.all(
    (sources as string[]).map(async (source) => {
      const collection = `${collectionPrefix}${source.toLowerCase()}`;
      try {
        const r = await fetch(`${base}/collections/${collection}/points/search`, {
          method: 'POST',
          headers: qdrantHeaders,
          body: JSON.stringify({
            vector: queryVector,
            limit: topK,
            with_payload: true,
            filter: { must_not: [{ has_id: [MANIFEST_ID] }] },
          }),
        });
        if (!r.ok) return [];
        const json: any = await r.json();
        return (json?.result ?? []).map((p: any) => {
          const pl = p.payload ?? {};
          return {
            text: pl.text ?? '',
            score: p.score as number,
            data: {
              sourceName: pl.sourceName ?? source,
              source: pl.url ?? '',
              fileName: pl.fileName ?? '',
            },
          };
        });
      } catch {
        return [];
      }
    }),
  );

  const hits = perSource
    .flat()
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return res.status(200).json({ hits });
}

async function embedQuery(text: string, apiKey: string): Promise<number[]> {
  const res = await fetch(`${GEMINI_API}/${GEMINI_MODEL}:embedContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: EMBED_DIMS,
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.embedding.values as number[];
}
