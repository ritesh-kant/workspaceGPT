/**
 * Multi-API-key failover for the browser-side LLM call. Mirrors the VS Code
 * extension's `apiKeyFailover.ts` so a share code carrying several keys gets
 * the same behavior here: only HTTP 429 (rate limit / quota) rotates to the
 * next key. Auth errors, timeouts, and 5xx surface immediately.
 */

/** True when an error represents an HTTP 429 (rate limit / over quota). */
export function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 429) return true;
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('rate limit') ||
    msg.includes('resource_exhausted')
  );
}

/**
 * Run `fn` with each key in turn, rotating to the next only when the previous
 * one fails with a 429. Empty/blank keys are dropped; if none remain, `fn` is
 * still called once with an empty string. Any non-429 error, or a 429 on the
 * last key, propagates to the caller.
 */
export async function withKeyFailover<T>(
  keys: Array<string | undefined | null>,
  fn: (key: string, index: number) => Promise<T>,
): Promise<T> {
  const candidates = keys.map((k) => (k ?? '').trim()).filter((k) => k.length > 0);
  const list = candidates.length > 0 ? candidates : [''];

  let lastErr: unknown;
  for (let i = 0; i < list.length; i++) {
    try {
      return await fn(list[i], i);
    } catch (err) {
      lastErr = err;
      const canRotate = isRateLimitError(err) && i < list.length - 1;
      if (!canRotate) throw err;
      console.warn(`[workspaceGPT] API key #${i + 1} rate-limited (429) — failing over to key #${i + 2} of ${list.length}.`);
    }
  }
  throw lastErr;
}
