import type { Env } from './env';
import { bearerToken, getSession } from './auth';
import { loadAccount } from './db';
import {
  creditsForTokens,
  decideAdmission,
  describeRefusal,
  estimateTokensFromChars,
  extractUsage,
  weeklyCreditLimitFor,
} from './metering';
import { chargeCredits, readUsageSnapshot, secondsUntilReset } from './usage';

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
  // Anthropic's top-level cache breakpoint. Harmless on the models this
  // proxy actually serves (they cache automatically) and needed the day the
  // configured model is a Claude one.
  'cache_control',
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
 * Usage is metered in TOKENS and presented as credits (see metering.ts). The
 * flow is admit → proxy → meter:
 *   · admit  — compare what the account has already spent this week against
 *              its weekly allowance; refuse with 429 if it is exhausted.
 *              Checked before anything is forwarded.
 *   · proxy  — stream the upstream body straight through to the client,
 *              untouched, with `stream_options.include_usage` forced on so the
 *              final SSE chunk carries the token counts.
 *   · meter  — a `tee()` of that same body is read to completion off the
 *              response path (`ctx.waitUntil`), the usage extracted, credits
 *              computed and charged. The request that crosses a limit is
 *              therefore always served; the next one is refused.
 *
 * Privacy: prompts pass through Worker memory in flight and are never logged
 * or stored. Nothing in this handler may log the request or response body —
 * the metering branch reads the body only to find the `usage` object.
 */
export async function handleChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
  // secret must not consume anyone's allowance.
  const apiKey = env[config.apiKeyEnv] as string | undefined;
  if (!apiKey || !config.chatUrl || !config.model) {
    console.error('[workspacegpt-api] missing vendor key, base URL, or model for configured provider', {
      provider: config.provider,
    });
    return errorResponse(500, 'Inference is not configured on the server.', 'server_misconfigured');
  }

  let rawBody: string;
  let body: any;
  try {
    rawBody = await request.text();
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, 'Request body must be JSON.', 'invalid_request');
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return errorResponse(400, '`messages` must be a non-empty array.', 'invalid_request');
  }

  // ── Admission ──
  // Decided on usage already recorded. A malformed request never reaches this
  // point, so it costs nothing; a refused one is not recorded either — there is
  // no denominator to protect now that the unit is tokens, not calls.
  const limitUser = { plan: user.plan, weekly_credit_limit: user.weekly_credit_limit ?? null };
  const weeklyLimit = weeklyCreditLimitFor(limitUser, config);
  const snapshot = await readUsageSnapshot(env, session.userId);
  const decision = decideAdmission({
    weeklyUsed: snapshot.weeklyCredits,
    weeklyLimit,
    secondsUntilWeeklyReset: secondsUntilReset(),
  });
  // Allowance headers reflect usage BEFORE this request — its own cost is only
  // known once the body has streamed. Good enough for a progress bar; `/v1/me`
  // is the precise read. Sent on refusals too, so a 429 shows the full bar.
  const allowanceHeaders: Record<string, string> = {
    'X-WorkspaceGPT-Credits-Used': String(snapshot.weeklyCredits),
    'X-WorkspaceGPT-Credits-Limit': String(weeklyLimit),
    'X-WorkspaceGPT-Credits-Period': 'week',
  };
  if (!decision.allowed) {
    return errorResponse(429, describeRefusal(decision), 'weekly_limit_reached', {
      'Retry-After': String(decision.retryAfterSec),
      ...allowanceHeaders,
    });
  }

  // Model choice is ours, not the client's: whatever id the extension sends is
  // symbolic (REMOTE_MODEL.ID) and replaced with the configured one here.
  const upstreamBody: Record<string, unknown> = { model: config.model };
  for (const field of PASSTHROUGH_FIELDS) {
    if (body[field] !== undefined) upstreamBody[field] = body[field];
  }
  // ── Prompt-cache / sticky-routing key ──
  // An agent run resends its whole conversation every round, so the cached
  // prefix is worth real money — but OpenRouter derives its sticky-routing
  // key by hashing the messages, which change every round, so later rounds
  // can land on an upstream whose cache is cold. The client sends a key that
  // is stable for its chat session; it is namespaced by account here rather
  // than forwarded verbatim, so one tenant's key can never steer another's
  // routing, and clipped to OpenRouter's 256-char limit.
  const clientCacheKey = typeof body.session_id === 'string' ? body.session_id : body.prompt_cache_key;
  if (typeof clientCacheKey === 'string' && clientCacheKey) {
    const scoped = `${session.userId}:${clientCacheKey}`.slice(0, 256);
    upstreamBody.session_id = scoped;
    upstreamBody.prompt_cache_key = scoped;
  }
  // Streamed responses only report token usage when asked. Forced on, so the
  // metering branch below always has something to read; the extra final chunk
  // (`choices: []`, `usage: {...}`) is ignored by the extension's stream
  // consumer, which only reads `choices[0].delta`.
  const isStream = body.stream === true;
  if (isStream) {
    const existing =
      body.stream_options && typeof body.stream_options === 'object' ? (body.stream_options as object) : {};
    upstreamBody.stream_options = { ...existing, include_usage: true };
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
    upstream = await fetch(config.chatUrl, {
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

  const headers = new Headers({
    'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': 'no-store',
    ...allowanceHeaders,
  });

  // Failed upstream calls (429 from the vendor, 5xx) pass through unmetered:
  // the user got no answer, so they are not charged for one. Other statuses
  // pass through so the client SDK can back off and retry.
  if (!upstream.ok || !upstream.body) {
    // Whose 4xx is this? The body the client gets is the VENDOR's, but the
    // extension logs it beside this Worker's baseUrl — which is how a vendor
    // `404 Invalid URL (POST /v1)` read as a broken Worker route on
    // 2026-09-07, and how a vendor's 400 over image content read as ours.
    // Name the hop: status and provider only, never the body.
    console.error('[workspacegpt-api] upstream rejected the request', {
      provider: config.provider,
      status: upstream.status,
    });
    headers.set('X-WorkspaceGPT-Upstream', config.provider);
    headers.set('X-WorkspaceGPT-Upstream-Status', String(upstream.status));
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // Stream the upstream body straight through — SSE deltas must not be
  // buffered, or the extension's token-by-token rendering dies. The tee gives
  // the metering branch its own copy to read at its own pace.
  const [toClient, toMeter] = upstream.body.tee();
  const contentType = upstream.headers.get('Content-Type');
  ctx.waitUntil(
    meterAndCharge(env, session.userId, toMeter, contentType, rawBody.length, config.tokensPerCredit).catch((error) => {
      console.error('[workspacegpt-api] metering failed; request not charged', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    })
  );
  return new Response(toClient, { status: upstream.status, headers });
}

/**
 * Read the metering copy of the response to the end, find the vendor's token
 * counts, convert to credits, record. Runs after the client already has its
 * stream, so nothing here is on the latency path. The body is read only to
 * locate `usage` — it is never logged or stored.
 */
async function meterAndCharge(
  env: Env,
  userId: string,
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
  requestBodyChars: number,
  tokensPerCredit: number
): Promise<void> {
  const text = await new Response(body).text();
  const usage = extractUsage(text, contentType);
  let tokens: number;
  if (usage) {
    tokens = usage.totalTokens;
  } else {
    // The vendor reported nothing. Charge for the prompt we know we sent
    // rather than nothing at all, and make the gap visible.
    tokens = estimateTokensFromChars(requestBodyChars);
    console.warn('[workspacegpt-api] upstream response carried no usage; charging estimated prompt tokens', {
      estimatedTokens: tokens,
    });
  }
  const credits = creditsForTokens(tokens, tokensPerCredit);
  await chargeCredits(env, userId, { credits, tokens });
}
