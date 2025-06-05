export interface EmbeddingConfig {
  modelName: string;
  dimensions: number;
  maxElements: number;
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
  source: string;
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