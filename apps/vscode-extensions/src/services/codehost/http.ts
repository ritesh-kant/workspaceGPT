export class CodeHostRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** One authenticated call; maps the failures a user can act on to plain sentences. Never logs the token. */
export async function hostFetch(label: string, host: string, url: string, headers: Record<string, string>, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', ...headers, ...(init?.headers ?? {}) },
  });
  if (response.ok) return response;
  const status = response.status;
  if (status === 401) throw new CodeHostRequestError(`${label} rejected the credential. Reconnect ${label} in Settings.`, status);
  if (status === 403 && response.headers.get('x-github-sso')) {
    throw new CodeHostRequestError(`This organization requires SSO: authorize the token for it on ${host}, then retry.`, status);
  }
  if (status === 403 || status === 429) {
    const limited = status === 429 || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('ratelimit-remaining') === '0';
    throw new CodeHostRequestError(limited ? `${label} rate limit reached. Try again in a few minutes.` : `${label} denied access. Check the token's scopes.`, status);
  }
  if (status === 404) throw new CodeHostRequestError(`Not found on ${label} (or the credential cannot see it).`, 404);
  throw new CodeHostRequestError(`${label} returned ${status}.`, status);
}

/** Trailing-whitespace-safe truncation for text that goes into the model's context. */
export const cut = (s: unknown, n: number): string => {
  const t = typeof s === 'string' ? s : '';
  return t.length > n ? `${t.slice(0, n)}… [truncated]` : t;
};

/** Last `lines` non-empty lines of a CI log, ANSI colour and leading timestamps removed, capped to `maxChars`. */
export function logTail(text: string, lines = 150, maxChars = 9_000): string {
  const out = text
    .split('\n')
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, ''))
    .filter((l) => l.trim())
    .slice(-lines)
    .join('\n');
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

export const BODY_CAP = 6_000;
export const PATCH_CAP = 3_000;
export const PATCH_TOTAL_CAP = 30_000;
export const COMMENT_CAP = 30;
export const COMMENT_BODY_CAP = 700;
