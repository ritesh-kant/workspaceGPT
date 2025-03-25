// VS Code Message Types
export const MESSAGE_TYPES = {
  SEND_MESSAGE: 'send-message',
  RECEIVE_MESSAGE: 'receive-message',
  CLEAR_CHAT: 'clear-chat',
  NEW_CHAT: 'new-chat',
  UPDATE_SETTINGS: 'update-settings',
  CHECK_CONFLUENCE_CONNECTION: 'check-confluence-connection',
  START_CONFLUENCE_SYNC: 'start-confluence-sync',
  SYNC_CONFLUENCE_PROGRESS: 'sync-confluence-progress',
  SYNC_CONFLUENCE_COMPLETE: 'sync-confluence-complete',
  SYNC_CONFLUENCE_ERROR:'sync-confluence-error',
  SYNC_GLOBAL_STATE:'sync-global-state',
  CLEAR_GLOBAL_STATE:'clear-global-state',
  SYNC_ERROR: 'sync-error'
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
  SETTINGS: 'globalSettings'
};

// Default Values
export const DEFAULTS = {
  MODEL_DIMENSIONS: 384 // Default dimension for all-MiniLM-L6-v2
};