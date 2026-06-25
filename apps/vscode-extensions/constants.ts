// VS Code Message Types
export const MESSAGE_TYPES = {
  SEND_MESSAGE: 'send-message',
  RECEIVE_MESSAGE: 'receive-message',
  RECEIVE_MESSAGE_CHUNK: 'receive-message-chunk',
  RECEIVE_MESSAGE_DONE: 'receive-message-done',
  CLEAR_CHAT: 'clear-chat',
  NEW_CHAT: 'new-chat',
  SHOW_SETTINGS: 'show-settings',
  UPDATE_MODEL: 'update-model',
  ERROR_CHAT: 'error-chat',
  RESET: 'reset',
  STOP_MESSAGE: 'stop-message',
  // Retrieval pipeline status (shown to user while loading)
  RETRIEVAL_STATUS: 'retrieval-status',

  // Chat History
  SAVE_CHAT_HISTORY: 'save-chat-history',
  GET_CHAT_HISTORY_LIST: 'get-chat-history-list',
  GET_CHAT_HISTORY_LIST_RESPONSE: 'get-chat-history-list-response',
  DELETE_CHAT_HISTORY: 'delete-chat-history',
  GET_CHAT_SESSION: 'get-chat-session',
  GET_CHAT_SESSION_RESPONSE: 'get-chat-session-response',
  SHOW_HISTORY: 'show-history',

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

  START_CONFLUENCE_OAUTH: 'start-confluence-oauth',
  CANCEL_CONFLUENCE_OAUTH: 'cancel-confluence-oauth',
  CONFLUENCE_OAUTH_SUCCESS: 'confluence-oauth-success',
  CONFLUENCE_OAUTH_ERROR: 'confluence-oauth-error',
  DISCONNECT_CONFLUENCE: 'disconnect-confluence',
  FETCH_CONFLUENCE_SPACES: 'fetch-confluence-spaces',
  FETCH_CONFLUENCE_SPACES_RESPONSE: 'fetch-confluence-spaces-response',
  FETCH_CONFLUENCE_SPACES_ERROR: 'fetch-confluence-spaces-error',

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

  // Azure DevOps messages
  CHECK_ADO_CONNECTION: 'check-ado-connection',
  START_ADO_SYNC: 'start-ado-sync',
  STOP_ADO_SYNC: 'stop-ado-sync',
  SYNC_ADO_IN_PROGRESS: 'sync-ado-progress',
  SYNC_ADO_COMPLETE: 'sync-ado-complete',
  ADO_CONNECTION_STATUS: 'ado-connection-status',
  SYNC_ADO_ERROR: 'sync-ado-error',
  SYNC_ADO_STOP: 'sync-ado-stop',
  RESUME_ADO_SYNC: 'resume-ado-sync',

  SAVE_ADO_PAT: 'save-ado-pat',
  ADO_PAT_SUCCESS: 'ado-pat-success',
  ADO_PAT_ERROR: 'ado-pat-error',
  FETCH_ADO_PROJECTS: 'fetch-ado-projects',
  FETCH_ADO_PROJECTS_SUCCESS: 'fetch-ado-projects-success',
  FETCH_ADO_PROJECTS_ERROR: 'fetch-ado-projects-error',
  DISCONNECT_ADO: 'disconnect-ado',

  INDEXING_ADO_ERROR: 'indexing-ado-error',
  INDEXING_ADO_IN_PROGRESS: 'indexing-ado-progress',
  INDEXING_ADO_COMPLETE: 'indexing-ado-complete',
  RESUME_INDEXING_ADO: 'resume-indexing-ado',

  FETCH_ADO_USER_IDENTITY: 'fetch-ado-user-identity',
  FETCH_ADO_USER_IDENTITY_SUCCESS: 'fetch-ado-user-identity-success',
  FETCH_ADO_USER_IDENTITY_ERROR: 'fetch-ado-user-identity-error',
  SAVE_ADO_USER_DISPLAY_NAME: 'save-ado-user-display-name',

  MODEL_DOWNLOAD_IN_PROGRESS: 'model-download-in-progress',
  MODEL_DOWNLOAD_COMPLETE: 'model-download-complete',
  MODEL_DOWNLOAD_ERROR: 'model-download-error',

  FETCH_AVAILABLE_MODELS: 'fetch-available-models',
  FETCH_AVAILABLE_MODELS_RESPONSE: 'fetch-available-models-response',
  FETCH_AVAILABLE_MODELS_ERROR: 'fetch-available-models-error',

  GET_WORKSPACE_PATH: 'get-workspace-path',
  WORKSPACE_PATH: 'workspace-path',

  // MCP Server
  SETUP_MCP: 'setup-mcp',
  MCP_STATUS: 'mcp-status',

  // Share to Chrome
  SHARE_TO_CHROME: 'share-to-chrome',

  // Deployment automation — provider connections (write-scoped, VS Code only)
  CHECK_GITHUB_CONNECTION: 'check-github-connection',
  START_GITHUB_INSTALL: 'start-github-install',
  CANCEL_GITHUB_INSTALL: 'cancel-github-install',
  GITHUB_CONNECTION_STATUS: 'github-connection-status',
  GITHUB_INSTALL_SUCCESS: 'github-install-success',
  GITHUB_INSTALL_ERROR: 'github-install-error',
  DISCONNECT_GITHUB: 'disconnect-github',

  CHECK_VERCEL_CONNECTION: 'check-vercel-connection',
  START_VERCEL_OAUTH: 'start-vercel-oauth',
  CANCEL_VERCEL_OAUTH: 'cancel-vercel-oauth',
  VERCEL_CONNECTION_STATUS: 'vercel-connection-status',
  VERCEL_OAUTH_SUCCESS: 'vercel-oauth-success',
  VERCEL_OAUTH_ERROR: 'vercel-oauth-error',
  DISCONNECT_VERCEL: 'disconnect-vercel',

  TEST_DEPLOYMENT_CONNECTIONS: 'test-deployment-connections',
  TEST_DEPLOYMENT_CONNECTIONS_RESULT: 'test-deployment-connections-result',

  // mach backend — classic PAT (set/clear/check), validated against both repos
  CHECK_MACH_TOKEN: 'check-mach-token',
  SET_MACH_TOKEN: 'set-mach-token',
  CLEAR_MACH_TOKEN: 'clear-mach-token',
  MACH_TOKEN_STATUS: 'mach-token-status',

  // Releases view
  SHOW_RELEASES: 'show-releases',
  RESOLVE_RELEASE: 'resolve-release',
  RESOLVE_RELEASE_RESPONSE: 'resolve-release-response',
  GET_RELEASE_RUNS: 'get-release-runs',
  GET_RELEASE_RUNS_RESPONSE: 'get-release-runs-response',
  PREPARE_CONFIG_SYNC: 'prepare-config-sync',
  PREPARE_CONFIG_SYNC_RESPONSE: 'prepare-config-sync-response',
  GET_VERCEL_PROJECTS: 'get-vercel-projects',
  GET_VERCEL_PROJECTS_RESPONSE: 'get-vercel-projects-response',
  PLAN_CONFIG_SYNC: 'plan-config-sync',
  PLAN_CONFIG_SYNC_RESPONSE: 'plan-config-sync-response',
  APPLY_CONFIG_SYNC: 'apply-config-sync',
  APPLY_CONFIG_SYNC_RESPONSE: 'apply-config-sync-response',
  // mach backend sync (component-version promotion via workflow_dispatch)
  PLAN_MACH_SYNC: 'plan-mach-sync',
  PLAN_MACH_SYNC_RESPONSE: 'plan-mach-sync-response',
  APPLY_MACH_SYNC: 'apply-mach-sync',
  APPLY_MACH_SYNC_RESPONSE: 'apply-mach-sync-response',
  CHECK_MACH_RUN: 'check-mach-run',
  CHECK_MACH_RUN_RESPONSE: 'check-mach-run-response',
  INJECT_WEBAPP_VERSION: 'inject-webapp-version',
  INJECT_WEBAPP_VERSION_RESPONSE: 'inject-webapp-version-response',

  // Vector store (Qdrant) connection test
  TEST_QDRANT_CONNECTION: 'test-qdrant-connection',
  TEST_QDRANT_CONNECTION_RESULT: 'test-qdrant-connection-result',
} as const;

/**
 * Normalize a Qdrant connection URL. Qdrant Cloud's dashboard shows the cluster
 * endpoint *without* a port, but its REST API listens on 6333 — pasting the bare
 * URL makes every request hit :443 and come back as Go's "404 page not found".
 * So we: ensure a scheme, default Qdrant Cloud hosts to :6333 when no port is
 * given, and strip trailing slashes. localhost, explicit ports, and non-cloud
 * hosts are left untouched; unparseable input is returned as-is (we never mangle).
 */
export function normalizeQdrantUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return trimmed;
  }
  if (!u.port && /\.cloud\.qdrant\.io$/i.test(u.hostname)) {
    u.port = '6333';
  }
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '');
}

export const SEARCH_CONSTANTS = {
  MAX_SEARCH_RESULTS: 15, // Number of nearest neighbors to retrieve
};

export const RETRIEVAL_THRESHOLDS = {
  // Per-intent minimum combined (cosine + BM25) score to include a result
  LOOKUP_MIN_SCORE: 0.2,
  AGGREGATION_MIN_SCORE: 0.2,
  SEMANTIC_MIN_SCORE: 0.3,
  COMPARISON_MIN_SCORE: 0.3,
  // If the best pass-1 score is below this, a second retrieval pass is triggered (semantic only)
  SEMANTIC_PASS2_TRIGGER: 0.45,
  // Reranker blend weights (must sum to 1.0)
  COSINE_WEIGHT: 0.65,
  BM25_WEIGHT: 0.35,
};

// Storage Keys
export const STORAGE_KEYS = {
  CHAT: 'chat',
  SETTINGS: 'settings',
  MODEL: 'model',
  CONFLUENCE_SYNC_PROGRESS: 'confluence-sync-progress',
  EMBEDDING_PROGRESS: 'embedding-progress',
  CODEBASE_SYNC_PROGRESS: 'codebase-sync-progress',
  CONFLUENCE_OAUTH_TOKENS: 'confluence-oauth-tokens',
  ADO_SYNC_PROGRESS: 'ado-sync-progress',
  ADO_OAUTH_TOKENS: 'ado-oauth-tokens',
  // Deployment automation — write-scoped creds (SecretStorage), never shared to Chrome
  GITHUB_OAUTH_TOKENS: 'github-oauth-tokens',
  // (Optional GitHub App mode — see GitHubAppAuthService)
  GITHUB_APP_INSTALLATION: 'github-app-installation',
  GITHUB_INSTALLATION_TOKEN_CACHE: 'github-installation-token-cache',
  VERCEL_OAUTH_TOKENS: 'vercel-oauth-tokens',
  // Classic PAT for mach (workflow_dispatch + PR), SSO-authorized by the user.
  GITHUB_MACH_PAT: 'github-mach-pat',
};

// Extension Constants
export const EXTENSION = {
  VIEW_TYPE: 'workspacegpt.chatView',
  COMMAND_ASK: 'workspacegpt.ask',
  COMMAND_NEW_CHAT: 'workspacegpt.newChat',
  COMMAND_SETTINGS: 'workspacegpt.settings',
  COMMAND_HISTORY: 'workspacegpt.history',
  COMMAND_CLEAR_DATA: 'workspacegpt.clearData',
  COMMAND_SHARE_TO_CHROME: 'workspacegpt.shareToChrome',
  COMMAND_RELEASES: 'workspacegpt.releases',
  VIEW_CONTAINER: 'workspacegpt-sidebar',
};

// Model Constants
export const MODEL = {
  DEFAULT_CHAT_MODEL: 'llama3.2:1b',

  DEFAULT_TEXT_EMBEDDING_DIMENSIONS: 384, // Default dimensions for the embedding model
  DEFAULT_TEXT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2', // Default Xenova embedding model

  DEFAULT_CODE_EMBEDDING_DIMENSIONS: 768, // Default dimensions for the embedding model
  DEFAULT_CODE_EMBEDDING_MODEL: 'jinaai/jina-embeddings-v2-base-code',
};
export const MODEL_PROVIDERS = [
  {
    MODEL_PROVIDER: 'Ollama',
    DEFAULT_CHAT_MODEL: undefined,
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
  {
    MODEL_PROVIDER: 'NVIDIA',
    requireApiKey: true,
    BASE_URL: 'https://integrate.api.nvidia.com/v1',
    DEFAULT_CHAT_MODEL: 'moonshotai/kimi-k2-instruct',
  },
];

export const WORKER_STATUS = {
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  ERROR: 'error',
  PROCESSED: 'processed',
};

// Atlassian OAuth 2.0 (3LO) Configuration
export const ATLASSIAN_OAUTH = {
  ATLASSIAN_CLIENT_ID: 'zP9e8TO6Rf7DIsVRtkbPJa2yi8WOeKGJ',
  // Token exchange is proxied through a Vercel function that holds the client_secret securely
  TOKEN_PROXY_URL: 'https://workspace-gpt-confluence-auth-proxy.vercel.app/api/token',
  AUTH_URL: 'https://auth.atlassian.com/authorize',
  TOKEN_URL: 'https://auth.atlassian.com/oauth/token',
  ACCESSIBLE_RESOURCES_URL: 'https://api.atlassian.com/oauth/token/accessible-resources',
  SCOPES: [
    'read:space:confluence',
    'search:confluence',
    'read:confluence-space.summary',
    'read:confluence-content.summary',
    'read:confluence-content.all',
    'read:page:confluence',
    'offline_access',
  ],
  CALLBACK_PORT: 32323,
  CALLBACK_PATH: '/callback',
};

// Azure DevOps OAuth 2.0 Configuration
export const ADO_OAUTH = {
  CLIENT_ID: 'REPLACE_WITH_ADO_APP_ID',
  TOKEN_PROXY_URL: 'https://workspace-gpt-ado-auth-proxy.vercel.app/api/token', // Example Proxy
  AUTH_URL: 'https://app.vssps.visualstudio.com/oauth2/authorize',
  TOKEN_URL: 'https://app.vssps.visualstudio.com/oauth2/token',
  SCOPES: [
    'vso.work',
    'vso.project',
    'vso.code'
  ],
  CALLBACK_PORT: 32324, // Use a different port than Confluence
  CALLBACK_PATH: '/callback',
};

/**
 * GitHub OAuth App configuration (deployment automation — write access).
 *
 * The "Authorize WorkspaceGPT" consent flow — same shape as the Confluence
 * OAuth flow: open the authorize URL, capture `code` on the loopback callback,
 * exchange it for a user access token via the proxy (which holds the
 * client_secret). No private key, no install dance.
 *
 * Required GitHub OAuth App settings when registering:
 *   - Authorization callback URL: http://127.0.0.1:32325/callback
 *   - (Optional) enable token expiration to get refresh tokens.
 *
 * Note: OAuth scopes are coarse — `repo` grants write to all repos the user can
 * access. For per-repo scoping use a fine-grained PAT or the GitHub App mode.
 */
export const GITHUB_OAUTH = {
  CLIENT_ID: 'Ov23liuwYl36ZVETh3Nk',
  AUTH_URL: 'https://github.com/login/oauth/authorize',
  TOKEN_PROXY_URL:
    'https://workspace-gpt-confluence-auth-proxy.vercel.app/api/github/oauth-token',
  API_BASE: 'https://api.github.com',
  SCOPES: ['repo', 'workflow'],
  CALLBACK_PORT: 32325,
  CALLBACK_PATH: '/callback',
};

/**
 * GitHub App configuration (OPTIONAL hardening mode — bot identity + per-repo
 * scoping + short-lived tokens). Not the active path; the OAuth App above is.
 *
 * Server-to-server model: the App is installed on the target repos by an admin,
 * and the proxy mints short-lived installation tokens from the App private key.
 * The extension never holds the key.
 *
 * Required GitHub App settings when registering:
 *   - Callback URL:  http://127.0.0.1:32325/callback
 *   - "Request user authorization (OAuth) during installation": ENABLED
 *     (so the post-install redirect carries `installation_id` + `state` to the
 *     local callback server).
 *   - Repository permissions: Contents (read/write), Pull requests (read/write),
 *     Workflows (read/write) — for mach config commits/PRs, tags, releases.
 */
export const GITHUB_APP = {
  // Public slug from github.com/apps/<slug>. Set after registering the App.
  APP_SLUG: 'REPLACE_WITH_GITHUB_APP_SLUG',
  INSTALL_BASE_URL: 'https://github.com/apps',
  // Proxy that holds the private key and mints installation tokens.
  INSTALLATION_TOKEN_PROXY_URL:
    'https://workspace-gpt-confluence-auth-proxy.vercel.app/api/github/installation-token',
  API_BASE: 'https://api.github.com',
  CALLBACK_PORT: 32325,
  CALLBACK_PATH: '/callback',
};

/**
 * mach (backend config) target configuration.
 *
 * Unlike Vercel/Confluence (OAuth via the proxy), the mach flow authenticates
 * with a **classic Personal Access Token** the user creates and SSO-authorizes
 * for both orgs themselves — org admins won't approve an OAuth App for these
 * repos. The PAT (scopes `repo` + `workflow`) lives in SecretStorage and is used
 * ONLY for these mach API calls; it is never included in the Chrome share bundle.
 *
 * Topology: config writes don't touch the mach repo directly. They trigger a
 * `workflow_dispatch` in the monorepo (where all the Actions live), which after
 * ~5 min opens a PR in the stage-mach repo. We never auto-merge (branch
 * protection); the apply surfaces the PR URL for human review.
 */
export const MACH = {
  API_BASE: 'https://api.github.com',
  /** Monorepo that hosts the Actions we dispatch. */
  MONOREPO_OWNER: 'Mars-Incorporated',
  MONOREPO_REPO: 'phoenix-mach-component-monorepo',
  /** Branch the workflow is dispatched against. */
  MONOREPO_REF: 'main',
  /**
   * Org that owns the per-environment mach repos. The actual repo is derived as
   * `aws-<brand>-phoenix-<env>-mach`, so the dispatched workflow opens its PR in
   * `${MACH_ENV_OWNER}/aws-<brand>-phoenix-<to>-mach` (~5 min later).
   */
  MACH_ENV_OWNER: 'Mars-Cloud-CoE',
  /** A representative repo in that org, used only to validate token reachability. */
  STAGE_OWNER: 'Mars-Cloud-CoE',
  STAGE_REPO: 'aws-mms-phoenix-stage-mach',
  /**
   * The config-sync workflow's display `name:` (resolved to its id at dispatch
   * time, so we don't hardcode/guess the bracketed filename).
   */
  WORKFLOW_NAME: '[deploy] Sync Components Across Environments',
  /** Defaults for the workflow_dispatch inputs; overridable in Settings/per-run. */
  DEFAULT_BRAND: 'mms',
  DEFAULT_FROM_BRANCH: 'main',
  /** Derive the per-environment mach repo name from brand + env. */
  envRepo(brand: string, env: string): string {
    return `aws-${brand}-phoenix-${env}-mach`;
  },
};

/**
 * Vercel OAuth integration configuration (deployment automation — frontend env).
 *
 * Standard OAuth code flow; the proxy holds the integration client_secret.
 * Integration access tokens are long-lived per install (no refresh grant).
 *
 * Required Vercel integration settings when registering:
 *   - Redirect URL: http://127.0.0.1:32326/callback
 */
export const VERCEL_OAUTH = {
  CLIENT_ID: 'oac_HBVNdJktT9K9b7IJDEf3D1Kv',
  // Integration slug from vercel.com/integrations/<slug>.
  INTEGRATION_SLUG: 'workspacegpt-deploy',
  AUTH_BASE_URL: 'https://vercel.com/integrations',
  TOKEN_PROXY_URL:
    'https://workspace-gpt-confluence-auth-proxy.vercel.app/api/vercel/token',
  API_BASE: 'https://api.vercel.com',
  CALLBACK_PORT: 32326,
  CALLBACK_PATH: '/callback',
};

export type ModelType = 'chat' | 'embedding';
export enum ModelTypeEnum {
  Chat = 'chat',
  Embedding = 'embedding',
}

// Used for incremental sync
// 20 minutes in milliseconds
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;