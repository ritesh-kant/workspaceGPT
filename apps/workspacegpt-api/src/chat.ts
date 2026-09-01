import type { Env } from './env';
import { bearerToken, getSession } from './auth';
import { loadAccount } from './db';
import { PROVIDERS } from './config';
import { consumeWeeklyRequest, secondsUntilReset, weeklyLimitFor } from './usage';

/**
 * Request fields forwarded upstream verbatim. An allowlist, not a blocklist:
 * the client must not be able to smuggle through fields that change who pays
 * or what gets logged (`model` is overridden below, and OpenRouter's routing
 * knobs like `provider`/`transforms`/`models` are deliberately absent).
 *
 * `tools`/`tool_choice` matter most — the agent loop in
 * apps/vscode-extensions/src/workers/model/modelWorker.ts is tool-calling, so
 * a proxy that dropped them would silently reduce remote mode to plain chat.
 */
const PASSTHROUGH_FIELDS = [
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'seed',
  'response_format',
  'reasoning',
] as const;

/** OpenAI-shaped error body, so the `openai` SDK on the client surfaces a useful `error.message`. */
function errorResponse(
  status: number,
  message: string,
  type: string,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify({ error: { message, type, code: type } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
  });
}

/**
 * `POST /v1/chat/completions` — OpenAI-compatible inference proxy, the data
 * plane of remote mode.
 *
 * Deliberately OpenAI-shaped: the extension talks to every provider through
 * `new OpenAI({ apiKey, baseURL })`, so pointing `baseURL` at this Worker and
 * passing the session token as `apiKey` reuses the entire existing streaming +
 * tool-calling client with no new transport. The session token is validated on
 * every single call (there is no client-side grace period) — an expired or
 * revoked session stops working on its next request.
 *
 * Privacy: prompts pass through Worker memory in flight and are never logged
 * or stored. Nothing in this handler may log the request or response body.
 */
export async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const token = bearerToken(request);
  const session = token ? await getSession(env, token) : null;
  if (!session) {
    return errorResponse(
      401,
      'Your WorkspaceGPT session is not valid. Sign in again under Settings → Account.',
      'not_signed_in'
    );
  }

  // The KV session is the fast path; the D1 row is the authority on whether
  // the account is still allowed to spend (suspension, plan changes). The
  // runtime config rides along in the same batch — see loadAccount.
  const { user, config } = await loadAccount(env, session.userId);
  if (!user || user.status !== 'active') {
    return errorResponse(403, 'This WorkspaceGPT account is not active.', 'account_inactive');
  }

  // Checked before anything is charged or even parsed: a deploy that forgot the
  // secret must not consume anyone's weekly allowance.
  const provider = PROVIDERS[config.provider];
  const apiKey = env[provider.apiKeyEnv as keyof Env] as string | undefined;
  if (!apiKey) {
    console.error('[workspacegpt-api] missing vendor key for configured provider', {
      provider: config.provider,
    });
    return errorResponse(500, 'Inference is not configured on the server.', 'server_misconfigured');
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Request body must be JSON.', 'invalid_request');
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return errorResponse(400, '`messages` must be a non-empty array.', 'invalid_request');
  }

  // Quota is spent only once the request is known to be well-formed and
  // serveable — a malformed body shouldn't cost the user part of their week's
  // allowance.
  const limit = weeklyLimitFor(user, config);
  const quota = await consumeWeeklyRequest(env, session.userId, limit);
  if (!quota.allowed) {
    return errorResponse(
      429,
      `Weekly WorkspaceGPT request limit reached (${limit}). It resets Monday at 00:00 UTC.`,
      'weekly_limit_reached',
      { 'Retry-After': String(secondsUntilReset()) }
    );
  }

  // Model choice is ours, not the client's: whatever id the extension sends is
  // symbolic (REMOTE_MODEL.ID) and replaced with the configured one here.
  const upstreamBody: Record<string, unknown> = { model: config.model };
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) upstreamBody[field] = body[field];
  }

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (config.provider === 'openrouter') {
    // OpenRouter attribution headers — identify the app, not the user.
    requestHeaders['HTTP-Referer'] = 'https://workspacegpt.dev';
    requestHeaders['X-Title'] = 'WorkspaceGPT';
  }

  let upstream: Response;
  try {
    upstream = await fetch(provider.chatUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(upstreamBody),
    });
  } catch (error) {
    // Status/shape only — never the request body.
    console.error('[workspacegpt-api] upstream fetch failed', {
      provider: config.provider,
      message: error instanceof Error ? error.message : 'unknown',
    });
    return errorResponse(502, 'The inference provider could not be reached.', 'upstream_unreachable');
  }

  // An upstream 401/403 means OUR vendor key is bad, not that the user's
  // session is — and the client maps 401 to "sign in again"
  // (describeLlmFailure in modelWorker.ts), which would blame the user for a
  // server misconfiguration. Never let those two statuses collide.
  if (upstream.status === 401 || upstream.status === 403) {
    console.error('[workspacegpt-api] provider rejected the vendor key', {
      provider: config.provider,
      status: upstream.status,
    });
    return errorResponse(
      502,
      'WorkspaceGPT could not authenticate with the inference provider. This is a server-side problem, not your account.',
      'upstream_auth_failed'
    );
  }

  // Stream the upstream body straight through — SSE deltas must not be
  // buffered, or the extension's token-by-token rendering dies. Other statuses
  // (including 429) pass through so the client SDK can back off and retry.
  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': 'no-store',
    'X-WorkspaceGPT-Requests-Used': String(quota.used),
    'X-WorkspaceGPT-Requests-Limit': String(limit),
    'X-WorkspaceGPT-Requests-Period': 'week',
  });
  return new Response(upstream.body, { status: upstream.status, headers });
}
