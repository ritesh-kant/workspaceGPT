// VS Code Message Types
export const MESSAGE_TYPES = {
  SEND_MESSAGE: 'send-message',
  RECEIVE_MESSAGE: 'receive-message',
  CLEAR_CHAT: 'clear-chat',
  NEW_CHAT: 'new-chat',
  SHOW_SETTINGS: 'show-settings',
  UPDATE_MODEL: 'update-model',
  ERROR_CHAT: 'error-chat',

  UPDATE_SETTINGS: 'update-settings',
  UPDATE_GLOBAL_STATE: 'update-global-state',
  CLEAR_GLOBAL_STATE: 'clear-global-state',
  GET_GLOBAL_STATE: 'get-global-state',
  GET_GLOBAL_STATE_RESPONSE: 'get-global-state-response',

  CHECK_CONFLUENCE_CONNECTION: 'check-confluence-connection',
  START_CONFLUENCE_SYNC: 'start-confluence-sync',
  STOP_CONFLUENCE_SYNC: 'stop-confluence-sync',
  SYNC_CONFLUENCE_IN_PROGRESS: 'sync-confluence-progress',
  SYNC_CONFLUENCE_COMPLETE: 'sync-confluence-complete',
  CONFLUENCE_CONNECTION_STATUS: 'confluence-connection-status',
  SYNC_CONFLUENCE_ERROR: 'sync-confluence-error',
  SYNC_CONFLUENCE_STOP: 'sync-confluence-stop',
  RESUME_CONFLUENCE_SYNC: 'resume-confluence-sync',

  START_CODEBASE_SYNC: 'start-codebase-sync',
  RESUME_CODEBASE_SYNC: 'resume-codebase-sync',
  SYNC_CODEBASE_IN_PROGRESS: 'sync-codebase-progress',
  SYNC_CODEBASE_COMPLETE: 'sync-codebase-complete',
  STOP_CODEBASE_SYNC: 'stop-codebase-sync',
  CODEBASE_CONNECTION_STATUS: 'codebase-connection-status',
  SYNC_CODEBASE_ERROR: 'sync-codebase-error',

  INDEXING_CONFLUENCE_ERROR: 'indexing-confluence-error',
  INDEXING_CONFLUENCE_IN_PROGRESS: 'indexing-confluence-progress',
  INDEXING_CONFLUENCE_COMPLETE: 'indexing-confluence-complete',
  RESUME_INDEXING_CONFLUENCE: 'resume-indexing-confluence',

  INDEXING_CODEBASE_ERROR: 'indexing-codebase-error',
  INDEXING_CODEBASE_IN_PROGRESS: 'indexing-codebase-progress',
  INDEXING_CODEBASE_COMPLETE: 'indexing-codebase-complete',
  RESUME_INDEXING_CODEBASE: 'resume-indexing-codebase',

  MODEL_DOWNLOAD_IN_PROGRESS: 'model-download-in-progress',
  MODEL_DOWNLOAD_COMPLETE: 'model-download-complete',
  MODEL_DOWNLOAD_ERROR: 'model-download-error',

  OLLAMA_STATUS: 'ollama-status',
  RETRY_OLLAMA_CHECK: 'retry-ollama-check',
  FETCH_AVAILABLE_MODELS: 'fetch-available-models',
  FETCH_AVAILABLE_MODELS_RESPONSE: 'fetch-available-models-response',
  FETCH_AVAILABLE_MODELS_ERROR: 'fetch-available-models-error',

  GET_WORKSPACE_PATH: 'get-workspace-path',
  WORKSPACE_PATH: 'workspace-path',
} as const;

export const SEARCH_CONSTANTS = {
  MAX_SEARCH_RESULTS: 5, // Number of nearest neighbors to retrieve
};

// Storage Keys
export const STORAGE_KEYS = {
  CHAT: 'chat',
  SETTINGS: 'settings',
  MODEL: 'model',
  CONFLUENCE_SYNC_PROGRESS: 'confluence-sync-progress',
  EMBEDDING_PROGRESS: 'embedding-progress',
  CODEBASE_SYNC_PROGRESS: 'codebase-sync-progress',
};

// Extension Constants
export const EXTENSION = {
  VIEW_TYPE: 'workspacegpt.chatView',
  COMMAND_ASK: 'workspacegpt.ask',
  COMMAND_NEW_CHAT: 'workspacegpt.newChat',
  COMMAND_SETTINGS: 'workspacegpt.settings',
  VIEW_CONTAINER: 'workspacegpt-sidebar',
};

// Model Constants
export const MODEL = {
  OLLAMA: 'Ollama',
  DEFAULT_CHAT_MODEL: 'llama3.2:1b',

  DEFAULT_TEXT_EMBEDDING_DIMENSIONS: 384, // Default dimensions for the embedding model
  DEFAULT_TEXT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2', // Default Xenova embedding model

  DEFAULT_CODE_EMBEDDING_DIMENSIONS: 768, // Default dimensions for the embedding model
  DEFAULT_CODE_EMBEDDING_MODEL: 'jinaai/jina-embeddings-v2-base-code',
};
export const MODEL_PROVIDERS = [
  {
    MODEL_PROVIDER: 'Ollama',
    DEFAULT_CHAT_MODEL: 'llama3.2:1b',
    API_KEY: 'DUMMY_API_KEY',
    BASE_URL: 'http://localhost:11434/v1',
    DEFAULT_TEXT_EMBEDDING_DIMENSIONS: 768, // Default dimensions for the embedding model
  },
  {
    MODEL_PROVIDER: 'OpenAI',
    requireApiKey: true,
    BASE_URL: 'https://api.openai.com/v1',
    DEFAULT_CHAT_MODEL: 'gpt-3.5-turbo',
  },
  {
    MODEL_PROVIDER: 'Gemini',
    requireApiKey: true,
    BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    DEFAULT_CHAT_MODEL: 'models/gemini-2.0-flash-exp',
  },
  {
    MODEL_PROVIDER: 'Groq',
    requireApiKey: true,
    BASE_URL: 'https://api.groq.com/openai/v1',
    DEFAULT_CHAT_MODEL: 'deepseek-r1-distill-llama-70b',
  },
  {
    MODEL_PROVIDER: 'Requesty',
    requireApiKey: true,
    BASE_URL: 'https://router.requesty.ai/v1',
    DEFAULT_CHAT_MODEL: 'google/gemini-2.0-flash-exp',
  },
  {
    MODEL_PROVIDER: 'OpenRouter',
    requireApiKey: true,
    BASE_URL: 'https://openrouter.ai/api/v1',
    DEFAULT_CHAT_MODEL: 'deepseek/deepseek-r1-distill-llama-70b',
  },
];

export const WORKER_STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error',
  PROCESSED: 'processed',
};

export type ModelType = 'chat' | 'embedding';
export enum ModelTypeEnum {
  Chat = 'chat',
  Embedding = 'embedding',
}
