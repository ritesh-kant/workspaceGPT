// VS Code Message Types
export const MESSAGE_TYPES = {
  SEND_MESSAGE: 'send-message',
  RECEIVE_MESSAGE: 'receive-message',
  CLEAR_CHAT: 'clear-chat',
  NEW_CHAT: 'new-chat',
  UPDATE_MODEL: 'update-model',

  UPDATE_SETTINGS: 'update-settings',
  SYNC_GLOBAL_STATE: 'sync-global-state',
  CLEAR_GLOBAL_STATE: 'clear-global-state',

  CHECK_CONFLUENCE_CONNECTION: 'check-confluence-connection',
  START_CONFLUENCE_SYNC: 'start-confluence-sync',
  SYNC_CONFLUENCE_IN_PROGRESS: 'sync-confluence-progress',
  SYNC_CONFLUENCE_COMPLETE: 'sync-confluence-complete',
  CONFLUENCE_CONNECTION_STATUS:'confluence-connection-status',
  SYNC_CONFLUENCE_ERROR: 'sync-confluence-error',

  SYNC_CODEBASE_IN_PROGRESS: 'sync-codebase-progress',
  SYNC_CODEBASE_COMPLETE: 'sync-codebase-complete',
  CODEBASE_CONNECTION_STATUS:'codebase-connection-status',
  SYNC_CODEBASE_ERROR: 'sync-codebase-error',

  INDEXING_CONFLUENCE_ERROR: 'indexing-confluence-error',
  INDEXING_CONFLUENCE_IN_PROGRESS: 'indexing-confluence-progress',
  INDEXING_CONFLUENCE_COMPLETE: 'indexing-confluence-complete',

  MODEL_DOWNLOAD_IN_PROGRESS: 'model-download-in-progress',
  MODEL_DOWNLOAD_COMPLETE: 'model-download-complete',
  MODEL_DOWNLOAD_ERROR: 'model-download-error',

};

// UI Constants
export const UI_CONSTANTS = {
  CHUNK_SIZE: 50, // Characters per chunk for streaming
  CHUNK_DELAY: 30, // Milliseconds between chunks
  MAX_SEARCH_RESULTS: 3 // Number of nearest neighbors to retrieve
};

// Storage Keys
export const STORAGE_KEYS = {
  CHAT: 'chat',
  SETTINGS: 'globalSettings',
  WORKSPACE_SETTINGS: 'workspaceGPT-settings',
};

// Extension Constants
export const EXTENSION = {
  VIEW_TYPE: 'workspacegpt.chatView',
  COMMAND_ASK: 'workspacegpt.ask',
  VIEW_CONTAINER: 'workspacegpt-sidebar'
};

// Model Constants
export const MODEL = {
  MODEL_PROVIDER: 'OLLAMA',
  DEFAULT_MODEL: 'llama3.2:1b',
  DEFAULT_DIMENSIONS: 768, // Default dimensions for the embedding model
  DEFAULT_OLLAMA_EMBEDDING_MODEL: 'nomic-embed-text' // Default Ollama embedding model
};

export const WORKER_STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error',
  PROCESSED: 'processed'
};
