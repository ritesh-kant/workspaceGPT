// VS Code Message Types
export const MESSAGE_TYPES = {
  SEND_MESSAGE: 'send-message',
  RECEIVE_MESSAGE: 'receive-message',
  CLEAR_CHAT: 'clear-chat',
  UPDATE_SETTINGS: 'update-settings',
  CHECK_CONNECTION: 'check-connection',
  START_SYNC: 'start-sync',
  SYNC_PROGRESS: 'sync-progress',
  SYNC_COMPLETE: 'sync-complete',
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