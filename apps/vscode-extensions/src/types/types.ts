export interface EmbeddingConfig {
  modelName: string;
  dimensions: number;
  maxElements: number;
  /** Which embedding backend to use. Defaults to 'local' when omitted. */
  provider?: 'local' | 'gemini';
  /** API key for cloud providers (gemini). */
  apiKey?: string;
}

export interface CodebaseConfig {
  repoPath: string;
  includePatterns: string;
  excludePatterns: string[];
  maxFileSizeKb: number;
  isSyncing?: boolean;
}

export interface EmbeddingSearchResult {
  text: string;
  score: number;
  data: {
    sourceName: 'CONFLUENCE' | 'CODEBASE' | 'ADO';
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

export type DataSource = 'CONFLUENCE' | 'ADO';

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
