import { EmbeddingIdentity } from './embeddingManifest';

export type SourceName = 'CONFLUENCE' | 'ADO' | 'CODEBASE';

/** One vector + everything search needs to rebuild a result. */
export interface VectorRecord {
  /** Stable id (e.g. `${sourceName}:${fileName}`) so re-sync overwrites in place. */
  id: string;
  vector: number[];
  payload: {
    text: string;
    fileName: string;
    url: string;
    sourceName: SourceName;
  };
}

/** Mirrors the SearchResult shape the reranker pipeline already consumes. */
export interface SearchHit {
  text: string;
  score: number;
  data: { sourceName: SourceName; source: string; fileName: string };
}

export interface VectorStore {
  readonly location: 'local' | 'cloud';

  /** Create/verify the backing collection matches this identity (dim + distance). */
  ensure(identity: EmbeddingIdentity, source: SourceName): Promise<void>;

  /** Idempotent insert/overwrite. Implementations batch internally. */
  upsert(records: VectorRecord[], source: SourceName): Promise<void>;

  /** Vector KNN. `queryVector` must come from the matching embedding model. */
  search(queryVector: number[], topK: number, source: SourceName): Promise<SearchHit[]>;

  /** Drop a source's vectors (e.g. on disconnect / clear-data). */
  clear(source: SourceName): Promise<void>;
}
