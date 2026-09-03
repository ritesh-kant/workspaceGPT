import type { Env } from './env';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_USER_EMAILS_URL = 'https://api.github.com/user/emails';

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface PendingLogin {
  /** The client's own loopback callback (e.g. http://127.0.0.1:32329/callback). */
  redirectUri: string;
  /** CSRF token the client generated; echoed back unmodified so it can re-validate. */
  csrf: string;
}

function toUrlSafeBase64(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromUrlSafeBase64(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

/**
 * The `state` param we send to GitHub carries the pending login round-trip
 * (which loopback port to 302 back to, and the client's own CSRF token) so
 * this Worker stays stateless between `/auth/login` and
 * `/auth/github/callback` — no KV write for a flow that might never finish.
 *
 * HMAC-SHA256 with the GitHub client secret so an attacker cannot mint or
 * rewrite `redirectUri` / `csrf` in flight.
 */
export async function encodePendingLogin(pending: PendingLogin, secret: string): Promise<string> {
  const payload = toUrlSafeBase64(JSON.stringify(pending));
  const sig = await hmacSha256Hex(secret, payload);
  return `${payload}.${sig}`;
}

export async function decodePendingLogin(state: string, secret: string): Promise<PendingLogin | null> {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = await hmacSha256Hex(secret, payload);
  if (!timingSafeEqualHex(sig, expected)) return null;
  try {
    const parsed = JSON.parse(fromUrlSafeBase64(payload));
    if (
      typeof parsed?.redirectUri === 'string' &&
      typeof parsed?.csrf === 'string' &&
      parsed.csrf.length >= 16 &&
      parsed.csrf.length <= 128
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function buildGithubAuthorizeUrl(env: Env, callbackUrl: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: callbackUrl,
    scope: 'read:user user:email',
    state,
  });
  return `${GITHUB_AUTHORIZE_URL}?${qs.toString()}`;
}

export async function exchangeCodeForGithubToken(
  env: Env,
  code: string,
  callbackUrl: string
): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed (${res.status})`);
  const data: any = await res.json();
  if (!data.access_token) throw new Error(data.error_description || 'GitHub token exchange returned no token');
  return data.access_token as string;
}

export interface GithubUser {
  id: number;
  login: string;
  created_at: string;
  email: string | null;
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * `/user`'s own `email` field is only populated when the account has a public
 * email set, which most accounts don't. `/user/emails` (needs the `user:email`
 * scope) is the reliable source regardless of that visibility setting.
 * Best-effort: sign-in must not fail just because this second call did.
 */
async function fetchGithubPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(GITHUB_USER_EMAILS_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'workspacegpt-api',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return null;
    const emails = (await res.json()) as GithubEmail[];
    if (!Array.isArray(emails)) return null;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return primary?.email ?? null;
  } catch {
    return null;
  }
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'workspacegpt-api',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub /user failed (${res.status})`);
  const data: unknown = await res.json();
  if (
    !data ||
    typeof data !== 'object' ||
    typeof (data as GithubUser).id !== 'number' ||
    typeof (data as GithubUser).login !== 'string' ||
    typeof (data as GithubUser).created_at !== 'string'
  ) {
    throw new Error('GitHub /user returned an unexpected payload');
  }
  const user = data as GithubUser;
  const email = (typeof user.email === 'string' && user.email) || (await fetchGithubPrimaryEmail(accessToken));
  return { id: user.id, login: user.login, created_at: user.created_at, email };
}

const MIN_ACCOUNT_AGE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/** Anti-abuse gate: reject sign-ins from GitHub accounts newer than 60 days. */
export function isAccountOldEnough(githubCreatedAt: string): boolean {
  const createdMs = Date.parse(githubCreatedAt);
  if (Number.isNaN(createdMs)) return false;
  return Date.now() - createdMs >= MIN_ACCOUNT_AGE_MS;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SessionRecord {
  userId: string;
  login: string;
  email: string | null;
  createdAt: number;
}

export async function createSession(
  env: Env,
  userId: string,
  login: string,
  email: string | null
): Promise<string> {
  const token = randomToken();
  const record: SessionRecord = { userId, login, email, createdAt: Date.now() };
  await env.SESSIONS.put(`session:${token}`, JSON.stringify(record), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

export async function getSession(env: Env, token: string): Promise<SessionRecord | null> {
  const raw = await env.SESSIONS.get(`session:${token}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

export async function deleteSession(env: Env, token: string): Promise<void> {
  await env.SESSIONS.delete(`session:${token}`);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}
