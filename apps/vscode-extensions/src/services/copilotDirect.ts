import * as vscode from 'vscode';
import type * as http from 'http';
import { randomUUID } from 'crypto';
import { COPILOT_PROVIDER, STORAGE_KEYS } from '../../constants';

/**
 * GitHub Copilot on hosts without `vscode.lm` — the desktop app. UNOFFICIAL.
 *
 * VS Code gets Copilot through the Language Model API (copilotBridge.ts). The
 * desktop has no such API, so here WorkspaceGPT talks to Copilot's own
 * OpenAI-compatible endpoint the way LiteLLM, CopilotChat.nvim and avante.nvim
 * do: GitHub device login with VS Code's Copilot app id, swap that token for a
 * short-lived Copilot token, and send VS Code's editor headers. GitHub does not
 * publish this API or sanction this use; it can break, and heavy automated use
 * can get a Copilot account warned or suspended. So it is strictly opt-in: the
 * sign-in dialog says all of this before any request is made.
 *
 * The loopback bridge still fronts it (same URL + token for every call site);
 * this module only swaps the backend from `vscode.lm` to a pass-through.
 */

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_API = 'https://api.githubcopilot.com';
/**
 * Copilot rejects requests without an editor identity; these are the values
 * LiteLLM ships. It keeps the older identity for GitHub's token exchange and
 * sends Copilot Chat's for the Copilot API itself, so the two differ here too.
 */
const EDITOR_HEADERS = {
  'editor-version': 'vscode/1.85.1',
  'editor-plugin-version': 'copilot/1.155.0',
  'user-agent': 'GithubCopilot/1.155.0',
  'copilot-integration-id': 'vscode-chat',
};
const copilotApiHeaders = () => ({
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'vscode/1.95.0',
  'editor-plugin-version': 'copilot-chat/0.26.7',
  'user-agent': 'GitHubCopilotChat/0.26.7',
  'openai-intent': 'conversation-panel',
  'x-github-api-version': '2025-04-01',
  'x-request-id': randomUUID(),
  'x-vscode-user-agent-library-version': 'electron-fetch',
});
/** Same floor as the vscode.lm path: small utility models can't hold an agent transcript. */
const MIN_INPUT_TOKENS = 100_000;

export interface DirectCopilotModel {
  id: string;
  maxInputTokens: number;
}

let secrets: vscode.SecretStorage | undefined;
let globalState: vscode.Memento | undefined;
let session: { token: string; api: string; expiresAt: number } | undefined;
let signingIn: Promise<void> | undefined;

/** Called once on activation; the GitHub token lives in the host's secret storage. */
export function initDirectCopilot(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
  globalState = context.globalState;
}

/** True when this host has no Language Model API and so uses this module. */
export function usesDirectCopilot(): boolean {
  return !vscode.lm?.selectChatModels;
}

/** A GitHub sign-in is stored (it may still turn out to be revoked on first use). */
export async function hasDirectCopilotSignIn(): Promise<boolean> {
  return !!(await secrets?.get(STORAGE_KEYS.COPILOT_GITHUB_TOKEN));
}

/** Forget the GitHub sign-in; the next Connect asks again. */
export async function signOutDirectCopilot(): Promise<void> {
  session = undefined;
  await secrets?.delete(STORAGE_KEYS.COPILOT_GITHUB_TOKEN);
}

/**
 * Signed in and at least one usable model. Signs in first only when asked
 * (the Connect button), so merely opening Settings never pops the dialog.
 * Returns an error message for Settings instead of throwing.
 */
export async function ensureDirectCopilotReady(allowSignIn: boolean): Promise<string | undefined> {
  try {
    if (!(await hasDirectCopilotSignIn())) {
      if (!allowSignIn) return 'GitHub Copilot is not connected. Use Connect under "Use a subscription".';
      signingIn ??= signIn().finally(() => (signingIn = undefined));
      await signingIn;
    }
    const models = await listDirectCopilotModels();
    console.log(`[copilot] ready: ${models.length} usable model(s): ${models.map((m) => m.id).join(', ')}`);
    return models.length ? undefined : 'Your GitHub Copilot plan has no chat models WorkspaceGPT can use.';
  } catch (err) {
    console.warn('[copilot] not ready:', err instanceof Error ? err.message : err);
    return err instanceof Error ? err.message : String(err);
  }
}

/** Copilot chat models that take tool calls on /chat/completions and hold an agent transcript. */
export async function listDirectCopilotModels(): Promise<DirectCopilotModel[]> {
  const { token, api } = await copilotSession();
  const res = await fetch(`${api}/models`, { headers: { ...copilotApiHeaders(), authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GitHub Copilot model list failed (${res.status}).`);
  const body: any = await res.json();
  return (body.data ?? [])
    .filter(
      (m: any) =>
        m.capabilities?.type === 'chat' &&
        m.capabilities?.supports?.tool_calls &&
        m.model_picker_enabled !== false &&
        (!m.supported_endpoints || m.supported_endpoints.includes('/chat/completions')) &&
        (m.capabilities?.limits?.max_prompt_tokens ?? 0) >= MIN_INPUT_TOKENS
    )
    .map((m: any) => ({ id: m.id, maxInputTokens: m.capabilities.limits.max_prompt_tokens }));
}

/**
 * Premium requests. Copilot bills a request it is told the user initiated
 * (`x-initiator: user`) and not the agent's own follow-ups; VS Code's agent
 * marks only the first request of a turn. Which request that is can't be
 * read off the transcript: the agent loop adds mid-run instructions as user
 * messages, and the intent classifier and exploration calls each open with
 * one, so guessing from the last message's role billed every one of them.
 * The host knows when the user acted and says so here; exactly one request
 * per user action then goes out as `user`. A turn that fails before any
 * request leaves its mark for the next one, so the error is at most one
 * extra billed request, never an unbilled user turn.
 */
let pendingUserTurns = 0;

/** A user action (a sent message, a deployment parse) whose next Copilot request is the user's. */
export function markUserTurn(): void {
  if (usesDirectCopilot()) pendingUserTurns++;
}

/** Bridge route: forward an OpenAI request to Copilot and stream its answer back unchanged. */
export async function forwardToCopilot(path: string, raw: string, res: http.ServerResponse): Promise<void> {
  const { token, api } = await copilotSession();
  const body = raw ? JSON.parse(raw) : undefined;
  if (Array.isArray(body?.messages)) markCacheBreakpoints(body.messages);
  if (body) applyReasoningEffort(body);
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  // One request per user action is the user's; see markUserTurn.
  const initiator = raw && pendingUserTurns > 0 ? (pendingUserTurns--, 'user') : 'agent';
  const upstream = await fetch(`${api}${path}`, {
    method: raw ? 'POST' : 'GET',
    headers: {
      ...copilotApiHeaders(),
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      // What VS Code sends: a turn the user typed is user-initiated; tool
      // follow-ups inside a run are the agent's.
      'x-initiator': initiator,
      // Copilot routes a request carrying images to a vision-capable backend only when told.
      ...(raw.includes('"image_url"') ? { 'copilot-vision-request': 'true' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: abort.signal,
  });
  if (upstream.status === 401) session = undefined;
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  if (!upstream.body) return void res.end();
  for await (const chunk of upstream.body as any) res.write(chunk);
  res.end();
}

/** Anthropic's floor for a thinking budget; a call capped below it (the intent classifier's 60) has no room to think. */
const MIN_THINKING_MAX_TOKENS = 1024;

/**
 * Settings → Model → Effort. Sent the way VS Code sends it: only when the
 * request's model declares that level in `capabilities.supports.reasoning_effort`
 * (kept on the stored model list), so a model without it, or an agent-run
 * model with other levels, gets Copilot's default rather than a 400. Unset
 * means Copilot decides. Short utility calls keep the default too.
 */
function applyReasoningEffort(body: any): void {
  const sel = (globalState?.get(STORAGE_KEYS.MODEL) as any)?.state?.selectedModelProvider;
  const effort = sel?.provider === COPILOT_PROVIDER ? sel.reasoningEffort : undefined;
  const levels = sel?.availableModels?.find((m: any) => m?.id === body.model)?.reasoningEfforts;
  if (!effort || !Array.isArray(levels) || !levels.includes(effort) || body.reasoning_effort !== undefined) return;
  if (typeof body.max_tokens === 'number' && body.max_tokens < MIN_THINKING_MAX_TOKENS) return;
  body.reasoning_effort = effort;
}

/**
 * Prompt caching. Copilot caches Claude models only at explicit breakpoints,
 * which it reads from a per-message `copilot_cache_control` field — what VS
 * Code's own Copilot agent sends on /chat/completions (OpenAI models cache the
 * prefix on their own and ignore it). An agent round resends the whole
 * transcript, so without these every round re-bills it in full. Anthropic
 * allows 4 breakpoints; this places at most 3:
 *  - the end of the leading system/user block (rules, tool schemas, ticket),
 *    which is identical for every round of the run;
 *  - the newest message, so the next round reads the whole transcript back;
 *  - the message before the newest assistant turn, where the previous round
 *    put its newest-message breakpoint, so that round's cache is still hit
 *    when this one appended more blocks than Anthropic's 20-block lookback.
 */
function markCacheBreakpoints(messages: any[]): void {
  const leading = (m: any) => m?.role === 'system' || m?.role === 'user';
  let lead = leading(messages[0]) ? 0 : -1;
  while (lead >= 0 && leading(messages[lead + 1])) lead++;
  const lastAssistant = messages.map((m) => m?.role).lastIndexOf('assistant');
  for (const i of new Set([lead, lastAssistant - 1, messages.length - 1])) {
    const m = messages[i];
    // Copilot only honours a breakpoint on a message with content; an
    // assistant turn carrying just tool calls has none.
    if (!m || m.role === 'assistant' || !(typeof m.content === 'string' ? m.content : m.content?.length)) continue;
    m.copilot_cache_control = { type: 'ephemeral' };
  }
}

/** Copilot's input limit for a model, which is often below the model's native window. */
export async function getDirectCopilotContextWindow(modelId: string): Promise<number | undefined> {
  try {
    return (await listDirectCopilotModels()).find((m) => m.id === modelId)?.maxInputTokens;
  } catch {
    return undefined;
  }
}

/** The short-lived Copilot token (about 30 minutes), refreshed two minutes before it expires. */
async function copilotSession(): Promise<{ token: string; api: string }> {
  if (session && session.expiresAt - 120_000 > Date.now()) return session;
  const githubToken = await secrets?.get(STORAGE_KEYS.COPILOT_GITHUB_TOKEN);
  if (!githubToken) throw new Error('GitHub Copilot is not connected. Use Connect in Settings → Model.');
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { ...EDITOR_HEADERS, accept: 'application/json', authorization: `token ${githubToken}` },
  });
  if (res.status === 401) {
    // Revoked or expired GitHub sign-in: forget it so Settings asks again.
    await secrets?.delete(STORAGE_KEYS.COPILOT_GITHUB_TOKEN);
    throw new Error('Your GitHub sign-in for Copilot has expired. Use Connect in Settings → Model to sign in again.');
  }
  if (res.status === 403 || res.status === 404) {
    throw new Error('This GitHub account has no active Copilot plan, or its organization does not allow this client.');
  }
  if (!res.ok) throw new Error(`GitHub Copilot sign-in check failed (${res.status}).`);
  const body: any = await res.json();
  session = { token: body.token, api: body.endpoints?.api ?? DEFAULT_API, expiresAt: body.expires_at * 1000 };
  return session;
}

/** GitHub device login, behind a dialog that states plainly what this is. */
async function signIn(): Promise<void> {
  const codeRes = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
  });
  if (!codeRes.ok) throw new Error(`GitHub sign-in could not start (${codeRes.status}).`);
  const code: any = await codeRes.json();

  const proceed = 'Copy code and open GitHub';
  const choice = await vscode.window.showWarningMessage(
    'Use GitHub Copilot in WorkspaceGPT Desktop? (unofficial)',
    {
      modal: true,
      detail:
        `GitHub doesn't offer Copilot to desktop apps like this one, so WorkspaceGPT connects the way LiteLLM does: it signs in as VS Code's Copilot client. ` +
        `It can stop working at any time, heavy use can get your Copilot access warned or suspended, and your organization's Copilot policy may not allow it. ` +
        `Requests count toward your Copilot plan.\n\nYour GitHub code: ${code.user_code} (copied when you continue)`,
    },
    proceed
  );
  if (choice !== proceed) throw new Error('GitHub Copilot sign-in cancelled.');
  await vscode.env.clipboard.writeText(code.user_code).then(undefined, () => undefined);
  await vscode.env.openExternal(vscode.Uri.parse(code.verification_uri));
  // The dialog that showed the code closes on click, and GitHub's page asks
  // for it — keep it on screen (not awaited) until the user is done.
  const copy = 'Copy code again';
  void vscode.window
    .showInformationMessage(
      `GitHub Copilot sign-in: enter ${code.user_code} on the GitHub page (it's on your clipboard). Waiting for GitHub…`,
      copy
    )
    .then((c) => {
      if (c === copy) void vscode.env.clipboard.writeText(code.user_code);
    });

  let interval = (code.interval ?? 5) * 1000;
  const deadline = Date.now() + (code.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const tokenRes = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const body: any = await tokenRes.json().catch(() => ({}));
    if (body.access_token) {
      await secrets?.store(STORAGE_KEYS.COPILOT_GITHUB_TOKEN, body.access_token);
      session = undefined;
      console.log('[copilot] GitHub sign-in stored');
      return;
    }
    if (body.error === 'slow_down') interval += 5000;
    else if (body.error !== 'authorization_pending') {
      throw new Error(body.error_description ?? `GitHub sign-in failed (${body.error ?? tokenRes.status}).`);
    }
  }
  throw new Error('GitHub sign-in timed out. Use Connect in Settings → Model to try again.');
}
