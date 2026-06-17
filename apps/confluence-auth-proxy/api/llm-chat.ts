/**
 * Vercel Edge Function: /api/llm-chat
 *
 * Proxies OpenAI-compatible chat completions so the LLM API key never leaves
 * the server. Supports streaming (SSE) transparently — the upstream response
 * body is piped directly back to the client.
 *
 * Accepts:
 *   POST { model: string, messages: ChatMessage[], stream: true, ...rest }
 *   Authorization: Bearer <access-token>
 *
 * Returns: SSE stream (text/event-stream) identical to the upstream provider.
 *
 * Env vars required:
 *   LLM_BASE_URL               — e.g. https://generativelanguage.googleapis.com/v1beta/openai
 *   LLM_API_KEY                — master API key (never sent to the client)
 *   WORKSPACEGPT_ACCESS_TOKEN  — shared token distributed to team members
 */

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Auth
  const accessToken = process.env.WORKSPACEGPT_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('WORKSPACEGPT_ACCESS_TOKEN not set');
    return json({ error: 'Server misconfigured' }, 500);
  }
  const authHeader = req.headers.get('authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!provided || provided !== accessToken) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const llmBase = process.env.LLM_BASE_URL;
  const llmKey = process.env.LLM_API_KEY;
  if (!llmBase || !llmKey) {
    console.error('LLM_BASE_URL or LLM_API_KEY not set');
    return json({ error: 'Server misconfigured' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { model, messages, ...rest } = body;
  if (!model || !Array.isArray(messages)) {
    return json({ error: 'Missing required fields: model, messages' }, 400);
  }

  const upstream = await fetch(
    `${llmBase.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llmKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true, ...rest }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return json({ error: `LLM request failed: ${upstream.status} ${detail}` }, 502);
  }

  // Pipe the SSE stream back — the edge runtime forwards chunks as they arrive.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
