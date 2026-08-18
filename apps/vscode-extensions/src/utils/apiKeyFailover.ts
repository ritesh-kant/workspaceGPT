/**
 * Multi-API-key failover. Users can configure several keys per provider (Model
 * and Embedding settings); when one is rate-limited we transparently retry the
 * same request with the next key.
 *
 * Rotation is intentionally narrow: only HTTP 429 (rate limit / quota) triggers
 * a switch. Auth errors (401/403), timeouts, and 5xx are NOT rotated — they
 * surface immediately so a genuinely broken key or request isn't masked. The
 * predicate is isolated in {@link isRateLimitError} so other conditions can be
 * added later without touching call sites.
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
 * still called once with an empty string (providers like Ollama need no key).
 * Any non-429 error, or a 429 on the last key, propagates to the caller.
 */
export async function withKeyFailover<T>(
  keys: Array<string | undefined | null>,
  fn: (key: string, index: number) => Promise<T>,
  /** Called (in addition to the console.warn) whenever a key rotates, so callers can surface it in the UI instead of leaving it silent in the extension host log. */
  onRotate?: (message: string) => void,
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
      const message = `API key #${i + 1} rate-limited (429) — failing over to key #${i + 2} of ${list.length}.`;
      console.warn(`[workspaceGPT] ${message}`);
      onRotate?.(message);
    }
  }
  throw lastErr;
}
