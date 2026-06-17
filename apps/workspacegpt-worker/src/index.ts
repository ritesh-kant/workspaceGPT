/**
 * WorkspaceGPT share proxy — Cloudflare Worker.
 *
 * Holds the real Qdrant / Gemini / LLM credentials server-side (in KV, keyed by
 * a random share token) so the Chrome extension never sees them. The extension
 * authenticates every request with its token; the admin (VS Code) authenticates
 * share creation/management with ADMIN_SECRET.
 *
 * Routes:
 *   POST   /share          (admin)  create a share, returns { token }
 *   GET    /shares         (admin)  list share tokens + metadata
 *   DELETE /share/:token   (admin)  revoke a share
 *   POST   /search         (token)  embed query (Gemini) + search Qdrant -> { hits }
 *   POST   /chat           (token)  stream chat completion (SSE passthrough)
 */

export interface Env {
  SHARES: KVNamespace;
  ADMIN_SECRET: string;
}

interface ShareConfig {
  qdrant: { url: string; apiKey?: string; collectionPrefix?: string };
  gemini: { apiKey: string; model: string; dimensions: number };
  llm: { baseUrl: string; apiKey: string; model: string };
  label?: string;
  createdAt: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const VALID_SOURCES = new Set(['CONFLUENCE', 'ADO', 'CODEBASE']);
const MANIFEST_ID = 0; // reserved Qdrant point holding the index identity
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TOP_K = 8;
const MAX_QUERY_CHARS = 7500;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    try {
      if (req.method === 'POST' && path === '/share') return cors(await createShare(req, env));
      if (req.method === 'GET' && path === '/shares') return cors(await listShares(req, env));
      if (req.method === 'DELETE' && path.startsWith('/share/')) {
        return cors(await revokeShare(decodeURIComponent(path.slice('/share/'.length)), req, env));
      }
      if (req.method === 'POST' && path === '/search') return cors(await search(req, env));
      if (req.method === 'POST' && path === '/chat') return cors(await chat(req, env));
      return cors(json({ error: 'Not found' }, 404));
    } catch (err: any) {
      console.error('Worker error:', err);
      return cors(json({ error: err?.message ?? 'Worker error' }, 500));
    }
  },
};

// ── Admin: share management ────────────────────────────────────────────────

async function createShare(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: 'Unauthorized' }, 401);

  const body = (await req.json().catch(() => null)) as any;
  if (!body?.qdrant?.url || !body?.gemini?.apiKey || !body?.llm?.apiKey) {
    return json({ error: 'Missing qdrant.url, gemini.apiKey, or llm.apiKey' }, 400);
  }

  const config: ShareConfig = {
    qdrant: {
      url: body.qdrant.url,
      apiKey: body.qdrant.apiKey,
      collectionPrefix: body.qdrant.collectionPrefix ?? '',
    },
    gemini: {
      apiKey: body.gemini.apiKey,
      model: body.gemini.model ?? 'gemini-embedding-001',
      dimensions: body.gemini.dimensions ?? 768,
    },
    llm: {
      baseUrl: body.llm.baseUrl,
      apiKey: body.llm.apiKey,
      model: body.llm.model,
    },
    label: body.label,
    createdAt: new Date().toISOString(),
  };

  const token = crypto.randomUUID();
  await env.SHARES.put(token, JSON.stringify(config), {
    metadata: { label: config.label ?? '', createdAt: config.createdAt },
  });

  return json({ token });
}

async function listShares(req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: 'Unauthorized' }, 401);
  const list = await env.SHARES.list<{ label: string; createdAt: string }>();
  const shares = list.keys.map((k) => ({
    token: k.name,
    label: k.metadata?.label ?? '',
    createdAt: k.metadata?.createdAt ?? '',
  }));
  return json({ shares });
}

async function revokeShare(token: string, req: Request, env: Env): Promise<Response> {
  if (!isAdmin(req, env)) return json({ error: 'Unauthorized' }, 401);
  if (!token) return json({ error: 'Missing token' }, 400);
  await env.SHARES.delete(token);
  return json({ ok: true });
}

// ── Client: retrieval + chat (token-authenticated) ─────────────────────────

async function search(req: Request, env: Env): Promise<Response> {
  const config = await authConfig(req, env);
  if (!config) return json({ error: 'Unauthorized' }, 401);

  const body = (await req.json().catch(() => null)) as any;
  const query: string = body?.query;
  const sources: string[] = body?.sources;
  const topK: number = body?.topK ?? DEFAULT_TOP_K;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return json({ error: 'Missing query' }, 400);
  }
  if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s) => VALID_SOURCES.has(s))) {
    return json({ error: 'sources must be a non-empty array of CONFLUENCE|ADO|CODEBASE' }, 400);
  }

  const queryVector = await embedQuery(query.slice(0, MAX_QUERY_CHARS), config.gemini);

  const base = config.qdrant.url.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.qdrant.apiKey) headers['api-key'] = config.qdrant.apiKey;
  const prefix = config.qdrant.collectionPrefix ?? '';

  const perSource = await Promise.all(
    sources.map(async (source) => {
      const collection = `${prefix}${source.toLowerCase()}`;
      try {
        const r = await fetch(`${base}/collections/${collection}/points/search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            vector: queryVector,
            limit: topK,
            with_payload: true,
            filter: { must_not: [{ has_id: [MANIFEST_ID] }] },
          }),
        });
        if (!r.ok) return [];
        const j: any = await r.json();
        return (j?.result ?? []).map((p: any) => {
          const pl = p.payload ?? {};
          return {
            text: pl.text ?? '',
            score: p.score as number,
            data: { sourceName: pl.sourceName ?? source, source: pl.url ?? '', fileName: pl.fileName ?? '' },
          };
        });
      } catch {
        return [];
      }
    }),
  );

  const hits = perSource.flat().sort((a, b) => b.score - a.score).slice(0, topK);
  return json({ hits });
}

async function chat(req: Request, env: Env): Promise<Response> {
  const config = await authConfig(req, env);
  if (!config) return json({ error: 'Unauthorized' }, 401);

  const body = (await req.json().catch(() => null)) as any;
  const messages: ChatMessage[] = body?.messages;
  if (!Array.isArray(messages)) return json({ error: 'Missing messages' }, 400);

  const upstream = await fetch(`${config.llm.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
    },
    body: JSON.stringify({ model: config.llm.model, messages, stream: true }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: `LLM request failed: ${upstream.status} ${detail}` }, 502);
  }

  // Pipe the SSE stream straight through — negligible CPU, no buffering.
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function embedQuery(text: string, gemini: ShareConfig['gemini']): Promise<number[]> {
  const model = `models/${gemini.model}`;
  const res = await fetch(`${GEMINI_API}/${model}:embedContent?key=${gemini.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      content: { parts: [{ text }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: gemini.dimensions,
    }),
  });
  if (!res.ok) throw new Error(`Gemini embed ${res.status}: ${await res.text()}`);
  const j: any = await res.json();
  return j.embedding.values as number[];
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function isAdmin(req: Request, env: Env): boolean {
  return !!env.ADMIN_SECRET && bearer(req) === env.ADMIN_SECRET;
}

async function authConfig(req: Request, env: Env): Promise<ShareConfig | null> {
  const token = bearer(req);
  if (!token) return null;
  const raw = await env.SHARES.get(token);
  return raw ? (JSON.parse(raw) as ShareConfig) : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(res.body, { status: res.status, headers: h });
}
