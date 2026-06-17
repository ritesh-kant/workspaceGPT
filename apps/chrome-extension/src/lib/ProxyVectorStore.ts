import { EmbeddingIdentity, SearchHit, SourceName, VectorRecord, VectorStore } from '@workspace-gpt/embedding-core';

export interface ProxyConfig {
  url: string; // base URL of the WorkspaceGPT proxy, e.g. https://my-proxy.vercel.app
  accessToken: string;
  collectionPrefix?: string;
}

/**
 * Read-only VectorStore that delegates search to the WorkspaceGPT proxy server.
 * The proxy holds the Qdrant API key server-side; the extension only needs the
 * short-lived access token distributed by the admin.
 */
export class ProxyVectorStore implements VectorStore {
  readonly location = 'cloud' as const;
  private base: string;
  private token: string;
  private prefix: string;

  constructor(cfg: ProxyConfig) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.token = cfg.accessToken;
    this.prefix = cfg.collectionPrefix ?? '';
  }

  async search(queryVector: number[], topK: number, source: SourceName): Promise<SearchHit[]> {
    const res = await fetch(`${this.base}/api/qdrant-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ source, vector: queryVector, topK, collectionPrefix: this.prefix }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Proxy search failed: ${res.status} ${detail}`);
    }

    const json: { hits: SearchHit[] } = await res.json();
    return json.hits;
  }

  // Chrome is query-only — VS Code handles all writes.
  async ensure(_identity: EmbeddingIdentity, _source: SourceName): Promise<void> {
    throw new Error('ProxyVectorStore is read-only');
  }
  async upsert(_records: VectorRecord[], _source: SourceName): Promise<void> {
    throw new Error('ProxyVectorStore is read-only');
  }
  async clear(_source: SourceName): Promise<void> {
    throw new Error('ProxyVectorStore is read-only');
  }
}
