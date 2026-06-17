import { EmbeddingIdentity } from './embeddingManifest';
import { SearchHit, SourceName, VectorRecord, VectorStore } from './VectorStore';

const UPSERT_BATCH = 128;
const MANIFEST_ID = 0;

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collectionPrefix?: string;
}

/** Qdrant over raw REST — identical to the VS Code module; runs unchanged in the browser. */
export class QdrantVectorStore implements VectorStore {
  readonly location = 'cloud' as const;
  private url: string;
  private apiKey?: string;
  private prefix: string;

  constructor(cfg: QdrantConfig) {
    this.url = cfg.url.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.prefix = cfg.collectionPrefix ?? '';
  }

  private collection(source: SourceName): string {
    return `${this.prefix}${source.toLowerCase()}`;
  }

  private req(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  async ensure(identity: EmbeddingIdentity, source: SourceName): Promise<void> {
    const name = this.collection(source);
    const existing = await this.req('GET', `/collections/${name}`);
    if (existing.ok) {
      const info: any = await existing.json();
      const size = info?.result?.config?.params?.vectors?.size;
      if (size && size !== identity.dimensions) {
        throw new Error(
          `Qdrant collection ${name} is ${size}-dim but ${identity.model} is ` +
            `${identity.dimensions}-dim. Recreate the collection to switch models.`,
        );
      }
      return;
    }
    const create = await this.req('PUT', `/collections/${name}`, {
      vectors: { size: identity.dimensions, distance: 'Cosine' },
    });
    if (!create.ok) {
      throw new Error(`Qdrant create collection failed: ${create.status} ${await create.text()}`);
    }
    await this.req('PUT', `/collections/${name}/points?wait=true`, {
      points: [
        {
          id: MANIFEST_ID,
          vector: new Array(identity.dimensions).fill(1),
          payload: { __manifest: { ...identity, source } },
        },
      ],
    });
  }

  async upsert(records: VectorRecord[], source: SourceName): Promise<void> {
    const name = this.collection(source);
    for (let i = 0; i < records.length; i += UPSERT_BATCH) {
      const slice = records.slice(i, i + UPSERT_BATCH);
      const res = await this.req('PUT', `/collections/${name}/points?wait=true`, {
        points: slice.map((r) => ({
          id: hashId(r.id),
          vector: r.vector,
          payload: { ...r.payload, srcId: r.id },
        })),
      });
      if (!res.ok) {
        throw new Error(`Qdrant upsert failed: ${res.status} ${await res.text()}`);
      }
    }
  }

  async search(queryVector: number[], topK: number, source: SourceName): Promise<SearchHit[]> {
    const name = this.collection(source);
    const res = await this.req('POST', `/collections/${name}/points/search`, {
      vector: queryVector,
      limit: topK,
      with_payload: true,
      filter: { must_not: [{ has_id: [MANIFEST_ID] }] },
    });
    if (!res.ok) {
      throw new Error(`Qdrant search failed: ${res.status} ${await res.text()}`);
    }
    const json: any = await res.json();
    return (json?.result ?? []).map((p: any) => {
      const pl = p.payload ?? {};
      return {
        text: pl.text ?? '',
        score: p.score,
        data: {
          sourceName: pl.sourceName as SourceName,
          source: pl.url ?? '',
          fileName: pl.fileName ?? '',
        },
      };
    });
  }

  async clear(source: SourceName): Promise<void> {
    const name = this.collection(source);
    const exists = await this.req('GET', `/collections/${name}`);
    if (exists.ok) {
      await this.req('DELETE', `/collections/${name}`);
    }
  }
}

function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
