export interface EmbeddingConfig {
  modelName: string;
  dimensions: number;
  maxElements: number;
  /** Which embedding backend to use. Defaults to 'local' when omitted. */
  provider?: 'local' | 'gemini';
  /** API key for cloud providers (gemini). */
  apiKey?: string;
  /** All configured keys for gemini, tried in order with 429 failover. */
  apiKeys?: string[];
  /** Where vectors are stored. Defaults to local (file-based) when omitted. */
  vectorStore?: {
    location: 'local' | 'cloud';
    qdrantUrl?: string;
    qdrantApiKey?: string;
  };
}

export interface EmbeddingSearchResult {
  text: string;
  score: number;
  data: {
    sourceName: 'CONFLUENCE' | 'ADO' | 'JIRA';
    source: string;
    fileName: string;
  };
}

export interface EmbeddingSearchMessage {
  type: 'results' | 'error';
  data?: EmbeddingSearchResult[];
  message?: string;
}

export interface EmbeddingProgress {
  processedFiles: number;
  totalFiles: number;
  lastProcessedFile?: string;
  isComplete: boolean;
}

// ── Retrieval pipeline types ──────────────────────────────────────────

export type QueryIntent = 'lookup' | 'semantic' | 'aggregation' | 'comparison' | 'chitchat';

export type DataSource = 'CONFLUENCE' | 'ADO' | 'JIRA' | 'CODEBASE';

export interface QueryClassification {
  intent: QueryIntent;
  sources: DataSource[];
  confidence: 'high' | 'low';
}

export interface RetrievalPlan {
  sources: DataSource[];
  topKPerPass: number;
  finalTopK: number;
  maxPasses: number;
  passThreshold: number;
  similarityThreshold: number;
  intent: QueryIntent;
}
