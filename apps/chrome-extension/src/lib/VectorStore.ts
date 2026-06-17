import { EmbeddingIdentity } from './embeddingManifest';

export type SourceName = 'CONFLUENCE' | 'ADO' | 'CODEBASE';

export interface VectorRecord {
  id: string;
  vector: number[];
  payload: {
    text: string;
    fileName: string;
    url: string;
    sourceName: SourceName;
  };
}

export interface SearchHit {
  text: string;
  score: number;
  data: { sourceName: SourceName; source: string; fileName: string };
}

export interface VectorStore {
  readonly location: 'local' | 'cloud';
  ensure(identity: EmbeddingIdentity, source: SourceName): Promise<void>;
  upsert(records: VectorRecord[], source: SourceName): Promise<void>;
  search(queryVector: number[], topK: number, source: SourceName): Promise<SearchHit[]>;
  clear(source: SourceName): Promise<void>;
}
