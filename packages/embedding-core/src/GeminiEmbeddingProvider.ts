import { EmbeddingProvider, EmbeddingTask } from './EmbeddingProvider';
import { EMBEDDING_PROFILES } from './embeddingProfiles';
import { EmbeddingIdentity } from './embeddingManifest';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL = 'models/gemini-embedding-001';
const MAX_BATCH = 100; // batchEmbedContents hard limit
const MAX_INPUT_CHARS = 7500; // ~2048-token cap, conservative (~3.6 chars/token)
const MIN_INTERVAL_MS = 650; // ~92 req/min — under the ~100 RPM free ceiling
const MAX_RETRIES = 5;

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
  private lastCall = 0;

  constructor(private apiKey: string) {}

  async embedBatch(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length > MAX_BATCH) {
      throw new Error(`Batch ${texts.length} exceeds ${MAX_BATCH}; chunk before calling.`);
    }

    await this.throttle();

    const body = {
      requests: texts.map((t) => ({
        model: MODEL,
        content: { parts: [{ text: truncate(t) }] },
        taskType: TASK[task],
        outputDimensionality: this.identity.dimensions,
      })),
    };

    const res = await this.fetchWithRetry(
      `${API}/${MODEL}:batchEmbedContents?key=${this.apiKey}`,
      body,
    );
    const json: any = await res.json();
    return json.embeddings.map((e: any) => e.values as number[]);
  }

  private async throttle(): Promise<void> {
    const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCall);
    if (wait > 0) await delay(wait);
    this.lastCall = Date.now();
  }

  private async fetchWithRetry(url: string, body: unknown, attempt = 0): Promise<Response> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      await delay(2 ** attempt * 1000); // 1, 2, 4, 8, 16s
      return this.fetchWithRetry(url, body, attempt + 1);
    }
    if (!res.ok) {
      throw new Error(`Gemini embed failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }
}

function truncate(t: string): string {
  return t.length > MAX_INPUT_CHARS ? t.slice(0, MAX_INPUT_CHARS) : t;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
