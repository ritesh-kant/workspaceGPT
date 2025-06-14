export interface SettingsButtonProps {
  isVisible: boolean;
  onBack: () => void;
}

export interface StatusMessage {
  section: 'confluence' | 'codebase';
  field: 'statusMessage' | 'messageType';
  value: string | 'unknown';
  delay?: number;
}

export interface ConfluenceConfig {
  baseUrl: string;
  spaceKey: string;
  userEmail: string;
  apiToken: string;
  isConfluenceEnabled: boolean;
  confluenceSyncProgress: number;
  confluenceIndexProgress: number;
  isSyncing: boolean;
  isIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
  messageType: 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
}

export interface CodebaseConfig {
  repoPath: string;
  scanFrequency: string;
  includePatterns: string;
  excludePatterns: string;
  maxFileSizeKb: number;
  isSyncing: boolean;
  isIndexing: boolean;
  isCodebaseEnabled: boolean;
  codebaseSyncProgress: number;
  codebaseIndexProgress: number;
  messageType: 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
}
export interface AvailableModel {
  id: string;
}

export interface ModelConfig {
  selectedModel?: string;
  provider: string;
  apiKey?: string;
  downloadProgress: number;
  downloadStatus: 'idle' | 'downloading' | 'completed' | 'error';
  errorMessage?: string;
  availableModels?: AvailableModel[];
  isLoadingModels?: boolean;
}