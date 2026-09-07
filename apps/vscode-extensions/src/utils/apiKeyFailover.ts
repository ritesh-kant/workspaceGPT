/**
 * Multi-API-key failover and transient-outage retry for provider requests.
 *
 * Two distinct failures are handled here, because they call for opposite
 * responses:
 *
 * - **HTTP 429 (rate limit / quota)** is usually a fact about ONE key, so the
 *   first fix is to rotate to the next configured key.
 *
 *   But when there is no other key to rotate to, a 429 used to be fatal — and
 *   that is wrong for the common case. A *quota* 429 (out of credit) does not
 *   clear on its own; a *rate* 429 (too many requests per minute) clears in
 *   seconds, and it is exactly what a long agentic run produces, because such
 *   a run is a burst of requests by nature. Observed live 2026-09-06: an
 *   agent-smoke s2 run applied four correct edits, ran the tests, and was then
 *   killed by "429 status code (no body)" on its next turn — fifteen tool
 *   calls of finished work thrown away over a limit that would have cleared
 *   before anyone noticed. Removing the turn cap makes this MORE likely, not
 *   less, since runs now issue more requests.
 *
 *   So the last key waits a 429 out on the same schedule as an outage. If it
 *   really is exhausted quota, the waits cost under a minute and the error
 *   still surfaces; if it was a per-minute limit, the run survives.
 * - **A 5xx / "overloaded" response** is a fact about the PROVIDER, so the fix
 *   is to wait and retry the SAME key. Rotating keys cannot help when every
 *   endpoint behind the provider is saturated, and it would burn the user's
 *   other keys against an outage.
 *
 * Everything else — auth errors (401/403), malformed requests (4xx) — still
 * surfaces immediately, so a genuinely broken key or request is never masked
 * by retries.
 *
 * Why the outage path exists at all: on ticket #1324128 a single OpenRouter
 * "Service temporarily unavailable. All endpoints are currently overloaded."
 * arrived on turn 18 of an agent run and ended it. Only 429 was retryable, so
 * the error propagated straight out, chatService settled the run, and the
 * worker's entire `messages` array — eighteen steps of investigation — was
 * discarded with it. The OpenAI SDK's own retries (0.5s then 1s by default)
 * are sized for a network blip, not for a provider under load. A run that has
 * already spent minutes can afford to wait; what it cannot afford is to throw
 * the work away.
 *
 * Rotation is sticky across calls: call sites invoke this once per request
 * (a chat turn, an explorer, a search), so without memory of past rotations
 * every new call would retry the already-rate-limited key #1 first. Instead
 * the index of the last known-good key is cached per key list (see
 * {@link stickyStart}), so once key #1 is confirmed rate-limited, subsequent
 * calls start at key #2 directly — and move on to #3 if #2 also 429s.
 * Transient outages deliberately do NOT move the sticky index: the key was
 * never at fault.
 */

/**
 * Last known-good starting index per key list, so a new call doesn't retry a
 * key already confirmed rate-limited. Keyed by the list's contents (not
 * object identity) since most call sites rebuild the array from settings on
 * every call.
 */
const stickyStart = new Map<string, number>();

function listKey(list: string[]): string {
  return list.join(' ');
}

/**
 * Waits before each successive retry of a provider-side outage. Three
 * attempts total per key (the first try plus two retries).
 *
 * Sized against the two things that bound it. Above: the worker's stall
 * watchdog fires after 5 minutes of silence, and each attempt here also pays
 * the SDK's own internal backoff (~7.5s at maxRetries 4), so the worst case
 * is roughly 3 x 7.5s of SDK retries plus 20s of waiting here — about 45
 * seconds, and every wait posts a UI notice so the run is visibly alive.
 * Below: a provider that is briefly saturated needs seconds, not
 * milliseconds, which is exactly what the SDK's sub-second schedule fails to
 * give it.
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

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
 * True when an error looks like a transient provider-side failure worth
 * waiting out: a 5xx, a request timeout, or one of the capacity messages
 * providers return.
 *
 * The numeric text match is anchored to the START of the message on purpose.
 * The OpenAI SDK formats an APIError as `"<status> <message>"`, so a leading
 * "503" is a status code — but an unanchored search for "500" would also
 * match a context-length 400 that happens to quote a token count, turning a
 * permanent error into 20 seconds of pointless retrying. Phrase matching
 * covers the other route to this predicate: OpenRouter sometimes answers HTTP
 * 200 with an error payload, which reaches us as a bare Error carrying the
 * message and no status at all.
 */
export function isTransientServerError(err: any): boolean {
  if (isRateLimitError(err)) return false;
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === 'number' && ((status >= 500 && status < 600) || status === 408)) return true;
  const msg = String(err?.message ?? '');
  if (/^\s*(408|5\d\d)\b/.test(msg)) return true;
  const lower = msg.toLowerCase();
  return (
    lower.includes('overloaded') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout') ||
    lower.includes('internal server error') ||
    lower.includes('no healthy upstream')
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Injection points for tests, which must not actually wait 20 seconds. */
export interface FailoverOptions {
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

/**
 * Run `fn` with each key in turn.
 *
 * Rotates to the next key on a 429; waits and retries the same key on a
 * provider-side outage (see {@link TRANSIENT_RETRY_DELAYS_MS}). Empty/blank
 * keys are dropped; if none remain, `fn` is still called once with an empty
 * string (providers like Ollama need no key). Any other error, a 429 on the
 * last key, or an outage that outlives the retry schedule propagates to the
 * caller.
 */
export async function withKeyFailover<T>(
  keys: Array<string | undefined | null>,
  fn: (key: string, index: number) => Promise<T>,
  /**
   * Called (in addition to the console.warn) whenever a key rotates or an
   * outage retry is scheduled, so callers can surface it in the UI instead of
   * leaving it silent in the extension host log.
   */
  onRetryNotice?: (message: string) => void,
  opts?: FailoverOptions,
): Promise<T> {
  const candidates = keys.map((k) => (k ?? '').trim()).filter((k) => k.length > 0);
  const list = candidates.length > 0 ? candidates : [''];
  const cacheKey = listKey(list);
  const start = Math.min(stickyStart.get(cacheKey) ?? 0, list.length - 1);
  const sleep = opts?.sleep ?? defaultSleep;
  const delays = opts?.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;

  let lastErr: unknown;
  for (let i = start; i < list.length; i++) {
    // Retries of THIS key against a provider outage. Reset per key so a
    // rotation gets a full patience budget of its own.
    let outageRetries = 0;
    for (;;) {
      try {
        const result = await fn(list[i], i);
        stickyStart.set(cacheKey, i);
        return result;
      } catch (err) {
        lastErr = err;

        if (isRateLimitError(err)) {
          const isLastKey = i >= list.length - 1;
          if (!isLastKey) {
            const message = `API key #${i + 1} rate-limited (429) — failing over to key #${i + 2} of ${list.length}.`;
            console.warn(`[workspaceGPT] ${message}`);
            onRetryNotice?.(message);
            stickyStart.set(cacheKey, i + 1);
            break; // advance to the next key
          }
          // No key left to rotate to. Wait it out rather than throwing away
          // the run — a per-minute limit clears in seconds. Shares the outage
          // budget so a genuinely exhausted quota still surfaces promptly.
          if (outageRetries < delays.length) {
            const waitMs = delays[outageRetries];
            outageRetries++;
            const message =
              `Rate-limited (429) with no other API key to fail over to — waiting ` +
              `${Math.round(waitMs / 1000)}s and retrying (attempt ${outageRetries} of ${delays.length}).`;
            console.warn(`[workspaceGPT] ${message}`);
            onRetryNotice?.(message);
            await sleep(waitMs);
            continue; // same key, after the wait
          }
          throw err;
        }

        if (isTransientServerError(err) && outageRetries < delays.length) {
          const waitMs = delays[outageRetries];
          outageRetries++;
          const message =
            `Model provider is overloaded or unavailable — waiting ${Math.round(waitMs / 1000)}s and retrying ` +
            `(attempt ${outageRetries} of ${delays.length}).`;
          console.warn(`[workspaceGPT] ${message}`, err instanceof Error ? err.message : err);
          onRetryNotice?.(message);
          await sleep(waitMs);
          continue; // same key, after the wait
        }

        throw err;
      }
    }
  }
  throw lastErr;
}
