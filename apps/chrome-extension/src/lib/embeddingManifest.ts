// Shared with the VS Code extension. Keep in sync (future: extract to a package).
export type EmbeddingProviderId = 'local' | 'gemini';

export interface EmbeddingIdentity {
  provider: EmbeddingProviderId;
  model: string;
  dimensions: number;
  normalized: boolean;
}

export interface EmbeddingIndexManifest {
  schemaVersion: 1;
  embedding: EmbeddingIdentity;
  docTaskType?: string;
  source: 'CONFLUENCE' | 'ADO' | 'CODEBASE';
  count: number;
  builtAt: string;
  builtBy: string;
  shareable: boolean;
  total: number;
  dimensions: number;
  includesMetadata: boolean;
  metadataFields: string[];
}
