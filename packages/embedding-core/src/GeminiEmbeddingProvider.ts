import { EmbeddingProvider, EmbeddingTask } from './EmbeddingProvider';
import { EMBEDDING_PROFILES } from './embeddingProfiles';
import { EmbeddingIdentity } from './embeddingManifest';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'models/gemini-embedding-001';
const MAX_BATCH = 100; // batchEmbedContents hard limit (max items the API accepts per call)
const MAX_INPUT_CHARS = 7500; // ~2048-token cap, conservative (~3.6 chars/token)
const MAX_RETRIES = 6;

// ── Free-tier pacing ──────────────────────────────────────────────────────
// The binding free-tier limits are tokens-per-minute and items-per-minute, NOT
// HTTP-calls-per-minute. A single full 100-item batch can carry ~200k tokens,
// which is many times over the free TPM ceiling → instant 429. So we (a) cap how
// much each call carries and (b) pace by a rolling 60-second token+item budget.
const WINDOW_MS = 60_000;
const TPM_BUDGET = 28_000; // tokens/min — safety margin under the ~30k free ceiling
const RPM_BUDGET = 90; // items/min — under the ~100 RPM free ceiling (each item counts)
const MAX_CALL_TOKENS = 12_000; // never let one HTTP call exceed this (well under TPM)
const CHARS_PER_TOKEN = 3.6; // matches the MAX_INPUT_CHARS heuristic above

/** Rough token estimate for a chunk of text (chars ÷ ~3.6). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const TASK: Record<EmbeddingTask, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
};

/**
 * Gemini embeddings via the native batchEmbedContents endpoint (keeps taskType,
 * which the OpenAI-compat endpoint drops). Batches at 100, throttles to stay on
 * the free tier, and backs off on 429.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity = EMBEDDING_PROFILES.gemini;
  readonly maxBatchSize = MAX_BATCH;
  // Rolling window of recent calls for token+item pacing.
  private recent: Array<{ at: number; tokens: number; items: number }> = [];

  constructor(private apiKey: string) {}

  async embedBatch(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > MAX_BATCH) {
      throw new Error(`Batch ${texts.length} exceeds ${MAX_BATCH}; chunk before calling.`);
    }

    // Split the incoming batch into token-bounded sub-batches so a single HTTP
    // call never blows past the per-minute token ceiling on its own.
    const truncated = texts.map(truncate);
    const subBatches = this.splitByTokenBudget(truncated);

    const out: number[][] = [];
    for (const sub of subBatches) {
      const tokens = sub.reduce((sum, t) => sum + estimateTokens(t), 0);
      await this.throttle(tokens, sub.length);

      const body = {
        requests: sub.map((t) => ({
          model: MODEL,
          content: { parts: [{ text: t }] },
          taskType: TASK[task],
          outputDimensionality: this.identity.dimensions,
        })),
      };

      const res = await this.fetchWithRetry(
        `${API}/${MODEL}:batchEmbedContents?key=${this.apiKey}`,
        body,
      );
      const json: any = await res.json();
      for (const e of json.embeddings) out.push(e.values as number[]);
    }
    return out;
  }

  /** Group already-truncated texts so each group stays under MAX_CALL_TOKENS. */
  private splitByTokenBudget(texts: string[]): string[][] {
    const groups: string[][] = [];
    let cur: string[] = [];
    let curTokens = 0;
    for (const t of texts) {
      const tk = estimateTokens(t);
      if (cur.length > 0 && curTokens + tk > MAX_CALL_TOKENS) {
        groups.push(cur);
        cur = [];
        curTokens = 0;
      }
      cur.push(t);
      curTokens += tk;
    }
    if (cur.length > 0) groups.push(cur);
    return groups;
  }

  /**
   * Token+item-aware pacing over a rolling 60s window. Waits until sending
   * `tokens`/`items` would keep both under the free-tier budgets.
   */
  private async throttle(tokens: number, items: number): Promise<void> {
    // Loop because a single sleep may not be enough once other entries also age out.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const now = Date.now();
      this.recent = this.recent.filter((r) => now - r.at < WINDOW_MS);
      const usedTokens = this.recent.reduce((s, r) => s + r.tokens, 0);
      const usedItems = this.recent.reduce((s, r) => s + r.items, 0);

      if (usedTokens + tokens <= TPM_BUDGET && usedItems + items <= RPM_BUDGET) {
        this.recent.push({ at: now, tokens, items });
        return;
      }

      // Wait until the oldest entry leaves the window, then re-check.
      const oldest = this.recent[0];
      const wait = oldest ? WINDOW_MS - (now - oldest.at) + 50 : WINDOW_MS;
      console.log(
        `[workspaceGPT][gemini] pacing: ${usedTokens}/${TPM_BUDGET} tok, ` +
          `${usedItems}/${RPM_BUDGET} items in window — waiting ${Math.round(Math.max(wait, 250) / 1000)}s`,
      );
      await delay(Math.max(wait, 250));
    }
  }

  private async fetchWithRetry(url: string, body: unknown, attempt = 0): Promise<Response> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const text = await res.text();

      // A per-DAY free-tier quota (e.g. 1000 embed requests/day) only resets at
      // midnight Pacific — retrying for minutes is futile. Fail fast with an
      // actionable message instead of burning the retry budget.
      if (isDailyQuota(text)) {
        console.log('[workspaceGPT][gemini] daily free-tier quota exhausted — not retrying.');
        throw new Error(dailyQuotaMessage(text));
      }

      if (attempt < MAX_RETRIES) {
        // Per-minute quota: prefer the server-advertised retryDelay (~60s),
        // which is far longer than a plain exponential cap.
        const serverDelay = parseRetryDelayMs(text);
        const backoff = Math.min(2 ** attempt * 1000, 32_000); // 1,2,4,8,16,32s
        const waitMs = Math.max(serverDelay, backoff);
        console.log(
          `[workspaceGPT][gemini] 429 per-minute quota (attempt ${attempt + 1}/${MAX_RETRIES}) — ` +
            `retrying in ${Math.round(waitMs / 1000)}s` +
            (serverDelay ? ' (server retryDelay)' : ''),
        );
        await delay(waitMs);
        return this.fetchWithRetry(url, body, attempt + 1);
      }
    }
    if (!res.ok) {
      throw new Error(`Gemini embed failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }
}

/** Pull the RetryInfo.retryDelay (e.g. "37s") out of a 429 error body, in ms. */
function parseRetryDelayMs(body: string): number {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : 0;
}

/** True when the 429 is a per-day free-tier cap (resets daily, not in seconds). */
function isDailyQuota(body: string): boolean {
  return /PerDay/i.test(body) || /_free_tier_requests/i.test(body);
}

/** Friendly, actionable message for a daily-quota exhaustion. */
function dailyQuotaMessage(body: string): string {
  const limit = body.match(/"quotaValue"\s*:\s*"(\d+)"/)?.[1];
  return (
    `Gemini free-tier daily quota exhausted` +
    (limit ? ` (${limit} embed requests/day)` : '') +
    `. This resets at midnight Pacific time. ` +
    `To finish indexing today, switch Embedding provider to "Local" in Settings, ` +
    `or upgrade the Gemini API key to a paid tier. ` +
    `Note: each document counts as one request, so large spaces can exceed the free daily cap.`
  );
}

function truncate(t: string): string {
  return t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
