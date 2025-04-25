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