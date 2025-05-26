export interface SettingsButtonProps {
  isVisible: boolean;
  onBack: () => void;
}

export interface StatusMessage {
  section: 'confluence' | 'codebase';
  field: 'statusMessage' | 'connectionStatus';
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
  connectionStatus: 'unknown' | 'success' | 'error';
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
  connectionStatus: 'unknown' | 'success' | 'error';
  statusMessage: string;
  canResume: boolean;
  canResumeIndexing: boolean;
  isSyncCompleted: boolean;
  isIndexingCompleted: boolean;
}
