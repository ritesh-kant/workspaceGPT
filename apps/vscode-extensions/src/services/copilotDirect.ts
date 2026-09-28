import * as vscode from 'vscode';
import type * as http from 'http';
import { STORAGE_KEYS } from '../../constants';

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
/** Copilot rejects requests without an editor identity; these are the values LiteLLM ships. */
const EDITOR_HEADERS = {
  'editor-version': 'vscode/1.85.1',
  'editor-plugin-version': 'copilot/1.155.0',
  'user-agent': 'GithubCopilot/1.155.0',
  'copilot-integration-id': 'vscode-chat',
};
/** Same floor as the vscode.lm path: small utility models can't hold an agent transcript. */
const MIN_INPUT_TOKENS = 100_000;

export interface DirectCopilotModel {
  id: string;
  maxInputTokens: number;
}

let secrets: vscode.SecretStorage | undefined;
let session: { token: string; api: string; expiresAt: number } | undefined;
let signingIn: Promise<void> | undefined;

/** Called once on activation; the GitHub token lives in the host's secret storage. */
export function initDirectCopilot(context: vscode.ExtensionContext): void {
  secrets = context.secrets;
}

/** True when this host has no Language Model API and so uses this module. */
export function usesDirectCopilot(): boolean {
  return !vscode.lm?.selectChatModels;
}

/**
 * Signed in and at least one usable model, signing in first if needed. Returns
 * an error message for Settings instead of throwing.
 */
export async function ensureDirectCopilotReady(): Promise<string | undefined> {
  try {
    if (!(await secrets?.get(STORAGE_KEYS.COPILOT_GITHUB_TOKEN))) {
      signingIn ??= signIn().finally(() => (signingIn = undefined));
      await signingIn;
    }
    const models = await listDirectCopilotModels();
    return models.length ? undefined : 'Your GitHub Copilot plan has no chat models WorkspaceGPT can use.';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Copilot chat models that take tool calls on /chat/completions and hold an agent transcript. */
export async function listDirectCopilotModels(): Promise<DirectCopilotModel[]> {
  const { token, api } = await copilotSession();
  const res = await fetch(`${api}/models`, { headers: { ...EDITOR_HEADERS, authorization: `Bearer ${token}` } });
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

/** Bridge route: forward an OpenAI request to Copilot and stream its answer back unchanged. */
export async function forwardToCopilot(path: string, raw: string, res: http.ServerResponse): Promise<void> {
  const { token, api } = await copilotSession();
  const body = raw ? JSON.parse(raw) : undefined;
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  const last = body?.messages?.[body.messages.length - 1];
  const upstream = await fetch(`${api}${path}`, {
    method: raw ? 'POST' : 'GET',
    headers: {
      ...EDITOR_HEADERS,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'openai-intent': 'conversation-panel',
      // What VS Code sends: a turn the user typed is user-initiated; tool
      // follow-ups inside a run are the agent's.
      'x-initiator': last?.role === 'user' ? 'user' : 'agent',
    },
    body: raw || undefined,
    signal: abort.signal,
  });
  if (upstream.status === 401) session = undefined;
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
  if (!upstream.body) return void res.end();
  for await (const chunk of upstream.body as any) res.write(chunk);
  res.end();
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
  if (!githubToken) throw new Error('Sign in to GitHub Copilot in Settings → Model.');
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { ...EDITOR_HEADERS, accept: 'application/json', authorization: `token ${githubToken}` },
  });
  if (res.status === 401) {
    // Revoked or expired GitHub sign-in: forget it so Settings asks again.
    await secrets?.delete(STORAGE_KEYS.COPILOT_GITHUB_TOKEN);
    throw new Error('Your GitHub sign-in for Copilot has expired. Pick GitHub Copilot in Settings → Model to sign in again.');
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
      return;
    }
    if (body.error === 'slow_down') interval += 5000;
    else if (body.error !== 'authorization_pending') {
      throw new Error(body.error_description ?? `GitHub sign-in failed (${body.error ?? tokenRes.status}).`);
    }
  }
  throw new Error('GitHub sign-in timed out. Pick GitHub Copilot in Settings → Model to try again.');
}
