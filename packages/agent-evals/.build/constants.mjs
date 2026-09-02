// ../../apps/vscode-extensions/constants.ts
var MESSAGE_TYPES = {
  SEND_MESSAGE: "send-message",
  RECEIVE_MESSAGE: "receive-message",
  RECEIVE_MESSAGE_CHUNK: "receive-message-chunk",
  RECEIVE_MESSAGE_DONE: "receive-message-done",
  CLEAR_CHAT: "clear-chat",
  NEW_CHAT: "new-chat",
  SHOW_SETTINGS: "show-settings",
  // Webview → host: move the chat into an editor tab / back to the sidebar.
  OPEN_CHAT_IN_EDITOR: "open-chat-in-editor",
  RESTORE_CHAT_TO_SIDEBAR: "restore-chat-to-sidebar",
  // Host → webview: which surface this instance is rendering in.
  CHAT_LAYOUT: "chat-layout",
  // Host ↔ webview: copy the live zustand chat (and in-flight stream) between
  // the sidebar and editor webviews, which do not share a JS heap.
  CHAT_SNAPSHOT_REQUEST: "chat-snapshot-request",
  CHAT_SNAPSHOT: "chat-snapshot",
  CHAT_SNAPSHOT_APPLY: "chat-snapshot-apply",
  // Webview → host: React has mounted and can receive a snapshot.
  CHAT_WEBVIEW_READY: "chat-webview-ready",
  // Webview → host: the sidebar was dragged below SIDEBAR_MIN_WIDTH_PX; hide
  // the bar that currently hosts this view instead of rendering a broken layout.
  COLLAPSE_SIDEBAR: "collapse-sidebar",
  // Host → webview: the view was shown or hidden (another view took the
  // sidebar, the bar was closed, the icon was clicked). The webview cannot see
  // this on its own — a retained webview is an iframe whose `document.hidden`
  // tracks the window, not the sidebar — and without it the collapse watch
  // mistakes a reveal at a narrow width for a sash drag.
  VIEW_VISIBILITY: "view-visibility",
  ERROR_CHAT: "error-chat",
  RESET: "reset",
  STOP_MESSAGE: "stop-message",
  // Webview → host: thumbs up/down on an assistant response (satisfaction signal).
  MESSAGE_FEEDBACK: "message-feedback",
  // Webview → host: an onboarding funnel milestone (step viewed / skipped /
  // completed). Analytics-only — carries no user content, just which step and
  // whether the engine/Confluence were actually configured. Lets us see where
  // first-run setup is abandoned, which is invisible from chat events alone.
  ONBOARDING_EVENT: "onboarding-event",
  // Retrieval pipeline status (shown to user while loading)
  RETRIEVAL_STATUS: "retrieval-status",
  // One agent exploration step (structured: kind/title/detail/path) —
  // accumulated by the webview and persisted on the answer, unlike the
  // transient RETRIEVAL_STATUS label.
  AGENT_STEP: "agent-step",
  // Completion of a previously announced step (matched by id): result summary
  // ("28 results", "+2 −2", "exit 0"), status done/error, optional meta
  // (command output tail) — turns "Searched city" into "Searched city · 28 results".
  AGENT_STEP_UPDATE: "agent-step-update",
  // End-of-turn rollup for agent turns: how long the run took and which files
  // changed (+added/−removed per file). Rendered as the "N files changed" bar.
  AGENT_TURN_SUMMARY: "agent-turn-summary",
  // Webview → host: open a diff of an agent-changed file (original vs current).
  OPEN_DIFF_IN_EDITOR: "open-diff-in-editor",
  // Composer @-mentions: the webview asks for workspace files/folders matching
  // what the user has typed after "@", and the host answers with the ranked
  // candidates for the picker. Correlated by requestId so a slow response for
  // an older keystroke can't overwrite the current suggestions.
  SEARCH_MENTION_TARGETS: "search-mention-targets",
  SEARCH_MENTION_TARGETS_RESPONSE: "search-mention-targets-response",
  // Agent write tools: host → webview review card, webview → host decision.
  // The agent loop BLOCKS on the decision (worker awaits tool_response), so
  // every write is human-approved before it touches the workspace.
  AGENT_WRITE_REVIEW: "agent-write-review",
  AGENT_WRITE_DECISION: "agent-write-decision",
  // Host → webview: every parked review was auto-rejected (stop/worker death);
  // cards should collapse their buttons instead of dangling as live no-ops.
  AGENT_WRITE_REVIEWS_CLOSED: "agent-write-reviews-closed",
  // Webview → host: open a reviewed file (edit/create/delete) in the editor.
  OPEN_FILE_IN_EDITOR: "open-file-in-editor",
  // Webview → host: open an http(s) URL in the user's browser — the ticket
  // chip above an agent answer and any link in model prose. The host validates
  // the scheme (never command:/file:), since the URL can come from model text.
  OPEN_EXTERNAL: "open-external",
  // Webview → host: revert the workspace to the checkpoint taken right before
  // a given user turn's changes (per-message "Undo changes up to this point").
  // Host → webview: the outcome, so the button can clear or surface an error.
  AGENT_REVERT_CHECKPOINT: "agent-revert-checkpoint",
  AGENT_REVERT_DONE: "agent-revert-done",
  // Webview → host: branch + commit the turn's changes, push, open the PR page
  // and post the report on the ticket. Host → webview: outcome (correlated by requestId).
  AGENT_SHIP: "agent-ship",
  AGENT_SHIP_DONE: "agent-ship-done",
  // Chat History
  SAVE_CHAT_HISTORY: "save-chat-history",
  GET_CHAT_HISTORY_LIST: "get-chat-history-list",
  GET_CHAT_HISTORY_LIST_RESPONSE: "get-chat-history-list-response",
  DELETE_CHAT_HISTORY: "delete-chat-history",
  GET_CHAT_SESSION: "get-chat-session",
  GET_CHAT_SESSION_RESPONSE: "get-chat-session-response",
  SHOW_HISTORY: "show-history",
  // Host → chat webview: open this stored session (Sessions panel / commands).
  LOAD_CHAT_SESSION: "load-chat-session",
  // Chat webview → host: the visible session id changed (Sessions panel highlight).
  SESSION_CHANGED: "session-changed",
  // Host → Sessions webview.
  SESSIONS_LIST: "sessions-list",
  SESSIONS_TOGGLE_SEARCH: "sessions-toggle-search",
  UPDATE_SETTINGS: "update-settings",
  UPDATE_GLOBAL_STATE: "update-global-state",
  CLEAR_GLOBAL_STATE: "clear-global-state",
  GET_GLOBAL_STATE: "get-global-state",
  GET_GLOBAL_STATE_RESPONSE: "get-global-state-response",
  /**
   * Host → webview push for the sync fields the host owns (see
   * HOST_OWNED_SYNC_FIELDS). The settings store hydrates from global state
   * exactly once, so without this a background sync would never reach the UI.
   */
  BACKGROUND_SYNC_STATE: "background-sync-state",
  CHECK_CONFLUENCE_CONNECTION: "check-confluence-connection",
  START_CONFLUENCE_SYNC: "start-confluence-sync",
  STOP_CONFLUENCE_SYNC: "stop-confluence-sync",
  SYNC_CONFLUENCE_IN_PROGRESS: "sync-confluence-progress",
  SYNC_CONFLUENCE_COMPLETE: "sync-confluence-complete",
  CONFLUENCE_CONNECTION_STATUS: "confluence-connection-status",
  SYNC_CONFLUENCE_ERROR: "sync-confluence-error",
  SYNC_CONFLUENCE_STOP: "sync-confluence-stop",
  RESUME_CONFLUENCE_SYNC: "resume-confluence-sync",
  START_CONFLUENCE_OAUTH: "start-confluence-oauth",
  CANCEL_CONFLUENCE_OAUTH: "cancel-confluence-oauth",
  CONFLUENCE_OAUTH_SUCCESS: "confluence-oauth-success",
  CONFLUENCE_OAUTH_ERROR: "confluence-oauth-error",
  DISCONNECT_CONFLUENCE: "disconnect-confluence",
  FETCH_CONFLUENCE_SPACES: "fetch-confluence-spaces",
  FETCH_CONFLUENCE_SPACES_RESPONSE: "fetch-confluence-spaces-response",
  FETCH_CONFLUENCE_SPACES_ERROR: "fetch-confluence-spaces-error",
  START_CODEBASE_SYNC: "start-codebase-sync",
  RESUME_CODEBASE_SYNC: "resume-codebase-sync",
  SYNC_CODEBASE_IN_PROGRESS: "sync-codebase-progress",
  SYNC_CODEBASE_COMPLETE: "sync-codebase-complete",
  STOP_CODEBASE_SYNC: "stop-codebase-sync",
  CODEBASE_CONNECTION_STATUS: "codebase-connection-status",
  SYNC_CODEBASE_ERROR: "sync-codebase-error",
  INDEXING_CONFLUENCE_ERROR: "indexing-confluence-error",
  INDEXING_CONFLUENCE_IN_PROGRESS: "indexing-confluence-progress",
  INDEXING_CONFLUENCE_COMPLETE: "indexing-confluence-complete",
  RESUME_INDEXING_CONFLUENCE: "resume-indexing-confluence",
  INDEXING_CODEBASE_ERROR: "indexing-codebase-error",
  INDEXING_CODEBASE_IN_PROGRESS: "indexing-codebase-progress",
  INDEXING_CODEBASE_COMPLETE: "indexing-codebase-complete",
  RESUME_INDEXING_CODEBASE: "resume-indexing-codebase",
  // Azure DevOps messages
  CHECK_ADO_CONNECTION: "check-ado-connection",
  START_ADO_SYNC: "start-ado-sync",
  STOP_ADO_SYNC: "stop-ado-sync",
  SYNC_ADO_IN_PROGRESS: "sync-ado-progress",
  SYNC_ADO_COMPLETE: "sync-ado-complete",
  ADO_CONNECTION_STATUS: "ado-connection-status",
  SYNC_ADO_ERROR: "sync-ado-error",
  SYNC_ADO_STOP: "sync-ado-stop",
  RESUME_ADO_SYNC: "resume-ado-sync",
  // Microsoft sign-in via MSAL, using Microsoft's own well-known ADO client id
  // (primary auth mode — no local install needed). See ADO_MSAL below.
  CONNECT_ADO_MSAL: "connect-ado-msal",
  ADO_MSAL_SUCCESS: "ado-msal-success",
  ADO_MSAL_ERROR: "ado-msal-error",
  // Azure CLI passthrough (alternate auth mode for anyone already `az login`'d).
  CONNECT_ADO_AZURE_CLI: "connect-ado-azure-cli",
  ADO_AZURE_CLI_SUCCESS: "ado-azure-cli-success",
  ADO_AZURE_CLI_ERROR: "ado-azure-cli-error",
  // Personal Access Token (fallback auth mode).
  SAVE_ADO_PAT: "save-ado-pat",
  ADO_PAT_SUCCESS: "ado-pat-success",
  ADO_PAT_ERROR: "ado-pat-error",
  FETCH_ADO_ORGANIZATIONS: "fetch-ado-organizations",
  FETCH_ADO_ORGANIZATIONS_SUCCESS: "fetch-ado-organizations-success",
  FETCH_ADO_ORGANIZATIONS_ERROR: "fetch-ado-organizations-error",
  FETCH_ADO_PROJECTS: "fetch-ado-projects",
  FETCH_ADO_PROJECTS_SUCCESS: "fetch-ado-projects-success",
  FETCH_ADO_PROJECTS_ERROR: "fetch-ado-projects-error",
  DISCONNECT_ADO: "disconnect-ado",
  INDEXING_ADO_ERROR: "indexing-ado-error",
  INDEXING_ADO_IN_PROGRESS: "indexing-ado-progress",
  INDEXING_ADO_COMPLETE: "indexing-ado-complete",
  RESUME_INDEXING_ADO: "resume-indexing-ado",
  FETCH_ADO_USER_IDENTITY: "fetch-ado-user-identity",
  FETCH_ADO_USER_IDENTITY_SUCCESS: "fetch-ado-user-identity-success",
  FETCH_ADO_USER_IDENTITY_ERROR: "fetch-ado-user-identity-error",
  /** "Your work" panel: the tickets assigned to the signed-in user. */
  GET_MY_WORK_ITEMS: "get-my-work-items",
  GET_MY_WORK_ITEMS_RESPONSE: "get-my-work-items-response",
  SAVE_ADO_USER_DISPLAY_NAME: "save-ado-user-display-name",
  MODEL_DOWNLOAD_IN_PROGRESS: "model-download-in-progress",
  MODEL_DOWNLOAD_COMPLETE: "model-download-complete",
  MODEL_DOWNLOAD_ERROR: "model-download-error",
  FETCH_AVAILABLE_MODELS: "fetch-available-models",
  FETCH_AVAILABLE_MODELS_RESPONSE: "fetch-available-models-response",
  FETCH_AVAILABLE_MODELS_ERROR: "fetch-available-models-error",
  GET_WORKSPACE_PATH: "get-workspace-path",
  WORKSPACE_PATH: "workspace-path",
  // MCP Server
  SETUP_MCP: "setup-mcp",
  MCP_STATUS: "mcp-status",
  // Share to Chrome
  SHARE_TO_CHROME: "share-to-chrome",
  // Deployment presets — copy a preset's JSON to the clipboard
  COPY_DEPLOYMENT_PRESET: "copy-deployment-preset",
  // Deployment automation — provider connections (write-scoped, VS Code only)
  CHECK_GITHUB_CONNECTION: "check-github-connection",
  START_GITHUB_INSTALL: "start-github-install",
  CANCEL_GITHUB_INSTALL: "cancel-github-install",
  GITHUB_CONNECTION_STATUS: "github-connection-status",
  GITHUB_INSTALL_SUCCESS: "github-install-success",
  GITHUB_INSTALL_ERROR: "github-install-error",
  DISCONNECT_GITHUB: "disconnect-github",
  CHECK_VERCEL_CONNECTION: "check-vercel-connection",
  START_VERCEL_OAUTH: "start-vercel-oauth",
  CANCEL_VERCEL_OAUTH: "cancel-vercel-oauth",
  VERCEL_CONNECTION_STATUS: "vercel-connection-status",
  VERCEL_OAUTH_SUCCESS: "vercel-oauth-success",
  VERCEL_OAUTH_ERROR: "vercel-oauth-error",
  DISCONNECT_VERCEL: "disconnect-vercel",
  TEST_DEPLOYMENT_CONNECTIONS: "test-deployment-connections",
  TEST_DEPLOYMENT_CONNECTIONS_RESULT: "test-deployment-connections-result",
  // Remote-mode account (apps/workspacegpt-api Worker) — GitHub sign-in
  // gating use of remote mode. See RemoteSignInService.
  CHECK_REMOTE_SESSION: "check-remote-session",
  REMOTE_SESSION_STATUS: "remote-session-status",
  START_REMOTE_SIGN_IN: "start-remote-sign-in",
  REMOTE_SIGN_IN_SUCCESS: "remote-sign-in-success",
  REMOTE_SIGN_IN_ERROR: "remote-sign-in-error",
  SIGN_OUT_REMOTE: "sign-out-remote",
  REMOTE_SIGN_OUT_SUCCESS: "remote-sign-out-success",
  // mach backend — classic PAT (set/clear/check), validated against both repos
  CHECK_MACH_TOKEN: "check-mach-token",
  SET_MACH_TOKEN: "set-mach-token",
  CLEAR_MACH_TOKEN: "clear-mach-token",
  MACH_TOKEN_STATUS: "mach-token-status",
  // Releases view
  SHOW_RELEASES: "show-releases",
  RESOLVE_RELEASE: "resolve-release",
  RESOLVE_RELEASE_RESPONSE: "resolve-release-response",
  GET_RELEASE_RUNS: "get-release-runs",
  GET_RELEASE_RUNS_RESPONSE: "get-release-runs-response",
  PREPARE_CONFIG_SYNC: "prepare-config-sync",
  PREPARE_CONFIG_SYNC_RESPONSE: "prepare-config-sync-response",
  GET_VERCEL_PROJECTS: "get-vercel-projects",
  GET_VERCEL_PROJECTS_RESPONSE: "get-vercel-projects-response",
  // Discover-and-select: populate mach topology dropdowns from the live GitHub
  // API (using the mach PAT) instead of asking the user to type repo/workflow ids.
  DISCOVER_GITHUB: "discover-github",
  DISCOVER_GITHUB_RESPONSE: "discover-github-response",
  // Discover-and-select: detect the roster page's column headers so the column
  // mapping is a dropdown choice rather than bound to a fixed template layout.
  DISCOVER_ROSTER_COLUMNS: "discover-roster-columns",
  DISCOVER_ROSTER_COLUMNS_RESPONSE: "discover-roster-columns-response",
  PLAN_CONFIG_SYNC: "plan-config-sync",
  PLAN_CONFIG_SYNC_RESPONSE: "plan-config-sync-response",
  APPLY_CONFIG_SYNC: "apply-config-sync",
  APPLY_CONFIG_SYNC_RESPONSE: "apply-config-sync-response",
  // mach backend sync (component-version promotion via workflow_dispatch)
  PLAN_MACH_SYNC: "plan-mach-sync",
  PLAN_MACH_SYNC_RESPONSE: "plan-mach-sync-response",
  APPLY_MACH_SYNC: "apply-mach-sync",
  APPLY_MACH_SYNC_RESPONSE: "apply-mach-sync-response",
  CHECK_MACH_RUN: "check-mach-run",
  CHECK_MACH_RUN_RESPONSE: "check-mach-run-response",
  INJECT_WEBAPP_VERSION: "inject-webapp-version",
  INJECT_WEBAPP_VERSION_RESPONSE: "inject-webapp-version-response",
  // mach env-var (main.yml) config-sync against the open sync PR
  PLAN_MACH_ENV: "plan-mach-env",
  PLAN_MACH_ENV_RESPONSE: "plan-mach-env-response",
  APPLY_MACH_ENV: "apply-mach-env",
  APPLY_MACH_ENV_RESPONSE: "apply-mach-env-response",
  // Hotfix flow (tickets → commits → components → cherry-pick → tag → release)
  PLAN_HOTFIX: "plan-hotfix",
  PLAN_HOTFIX_RESPONSE: "plan-hotfix-response",
  APPLY_HOTFIX: "apply-hotfix",
  APPLY_HOTFIX_RESPONSE: "apply-hotfix-response",
  // Vector store (Qdrant) connection test
  TEST_QDRANT_CONNECTION: "test-qdrant-connection",
  TEST_QDRANT_CONNECTION_RESULT: "test-qdrant-connection-result"
};
function normalizeQdrantUrl(raw) {
  const trimmed = (raw ?? "").trim();
  if (!trimmed)
    return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return trimmed;
  }
  if (!u.port && /\.cloud\.qdrant\.io$/i.test(u.hostname)) {
    u.port = "6333";
  }
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
}
var MENTION_LIMITS = {
  /** Candidates offered in the picker. */
  MAX_SUGGESTIONS: 12,
  /** Mentions resolved into context for a single message. */
  MAX_PER_MESSAGE: 8
};
var ATTACHMENT_LIMITS = {
  /** Max attachments per message. */
  MAX_FILES: 4,
  /** Max raw size for an image attachment (base64 inflates ~33% on top). */
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  /** Text files are inlined into the prompt — truncate beyond this. */
  MAX_TEXT_CHARS: 1e5
};
var SEARCH_CONSTANTS = {
  MAX_SEARCH_RESULTS: 15
  // Number of nearest neighbors to retrieve
};
var RETRIEVAL_THRESHOLDS = {
  // Per-intent minimum combined (cosine + BM25) score to include a result
  LOOKUP_MIN_SCORE: 0.2,
  AGGREGATION_MIN_SCORE: 0.2,
  SEMANTIC_MIN_SCORE: 0.3,
  COMPARISON_MIN_SCORE: 0.3,
  // If the best pass-1 score is below this, a second retrieval pass is triggered (semantic only)
  SEMANTIC_PASS2_TRIGGER: 0.45,
  // Reranker blend weights (must sum to 1.0)
  COSINE_WEIGHT: 0.65,
  BM25_WEIGHT: 0.35
};
var STORAGE_KEYS = {
  CHAT: "chat",
  SETTINGS: "settings",
  MODEL: "model",
  CONFLUENCE_SYNC_PROGRESS: "confluence-sync-progress",
  EMBEDDING_PROGRESS: "embedding-progress",
  CODEBASE_SYNC_PROGRESS: "codebase-sync-progress",
  CONFLUENCE_OAUTH_TOKENS: "confluence-oauth-tokens",
  ADO_SYNC_PROGRESS: "ado-sync-progress",
  /** Which auth mode is active: 'msal' | 'azcli' | 'pat'. */
  ADO_AUTH_MODE: "ado-auth-mode",
  /** Raw PAT string — only present when ADO_AUTH_MODE is 'pat'. */
  ADO_PAT: "ado-pat",
  /** Serialized MSAL token cache — only present when ADO_AUTH_MODE is 'msal'. */
  ADO_MSAL_CACHE: "ado-msal-cache",
  /** Last successful "assigned to me" fetch, so the panel renders instantly. */
  ADO_MY_WORK_ITEMS_CACHE: "ado-my-work-items-cache",
  // Deployment automation — write-scoped creds (SecretStorage), never shared to Chrome
  GITHUB_OAUTH_TOKENS: "github-oauth-tokens",
  // (Optional GitHub App mode — see GitHubAppAuthService)
  GITHUB_APP_INSTALLATION: "github-app-installation",
  GITHUB_INSTALLATION_TOKEN_CACHE: "github-installation-token-cache",
  VERCEL_OAUTH_TOKENS: "vercel-oauth-tokens",
  // Classic PAT for mach (workflow_dispatch + PR), SSO-authorized by the user.
  GITHUB_MACH_PAT: "github-mach-pat",
  // Update-check throttling: { lastCheckedAt, lastNotifiedVersion }.
  UPDATE_CHECK_STATE: "update-check-state",
  // Remote-mode account session token (SecretStorage) — see REMOTE_AUTH. Also
  // doubles as the bearer credential for the inference proxy, so there is no
  // client-side "last validated" grace window: the Worker re-checks the
  // session on every /v1/chat/completions call.
  REMOTE_SESSION_TOKEN: "remote-session-token"
};
var EXTENSION = {
  VIEW_TYPE: "workspacegpt.chatView",
  EDITOR_VIEW_TYPE: "workspacegpt.chatEditor",
  SESSIONS_VIEW_TYPE: "workspacegpt.sessionsView",
  COMMAND_ASK: "workspacegpt.ask",
  COMMAND_NEW_CHAT: "workspacegpt.newChat",
  COMMAND_SETTINGS: "workspacegpt.settings",
  COMMAND_HISTORY: "workspacegpt.history",
  COMMAND_OPEN_CHAT_IN_EDITOR: "workspacegpt.openChatInEditor",
  COMMAND_RESTORE_CHAT_TO_SIDEBAR: "workspacegpt.restoreChatToSidebar",
  COMMAND_REFRESH_SESSIONS: "workspacegpt.refreshSessions",
  COMMAND_SEARCH_SESSIONS: "workspacegpt.searchSessions",
  CONTEXT_CHAT_IN_EDITOR: "workspacegpt.chatInEditor",
  COMMAND_CLEAR_DATA: "workspacegpt.clearData",
  COMMAND_SHARE_TO_CHROME: "workspacegpt.shareToChrome",
  COMMAND_RELEASES: "workspacegpt.releases",
  COMMAND_SIGN_IN_REMOTE: "workspacegpt.signInRemote",
  COMMAND_SIGN_OUT_REMOTE: "workspacegpt.signOutRemote",
  VIEW_CONTAINER: "workspacegpt-sidebar",
  CONTEXT_DEPLOYMENT_ENABLED: "workspacegpt.deploymentEnabled",
  /**
   * Gates the Share-to-Chrome title-bar action. Parked (always false) while
   * remote mode indexes locally: the Chrome extension reads the vector index
   * directly, and it cannot read a file-based index on someone else's machine.
   * Flip this to a real condition when a server-side index exists.
   */
  CONTEXT_SHARE_ENABLED: "workspacegpt.shareEnabled"
};
var SIDEBAR_MIN_WIDTH_PX = 220;
var REMOTE_MODEL = {
  PROVIDER: "WorkspaceGPT",
  ID: "workspacegpt-default",
  /** Human-readable label for the UI, where a model name would otherwise go. */
  LABEL: "WorkspaceGPT (managed)"
};
var MODEL = {
  DEFAULT_CHAT_MODEL: "llama3.2:1b",
  DEFAULT_TEXT_EMBEDDING_DIMENSIONS: 384,
  // Default dimensions for the embedding model
  DEFAULT_TEXT_EMBEDDING_MODEL: "Xenova/all-MiniLM-L6-v2",
  // Default Xenova embedding model
  DEFAULT_CODE_EMBEDDING_DIMENSIONS: 768,
  // Default dimensions for the embedding model
  DEFAULT_CODE_EMBEDDING_MODEL: "jinaai/jina-embeddings-v2-base-code"
};
var MODEL_PROVIDERS = [
  {
    MODEL_PROVIDER: "Ollama",
    DEFAULT_CHAT_MODEL: void 0,
    API_KEY: "DUMMY_API_KEY",
    BASE_URL: "http://localhost:11434/v1",
    DEFAULT_TEXT_EMBEDDING_DIMENSIONS: 768
    // Default dimensions for the embedding model
  },
  {
    MODEL_PROVIDER: "OpenAI",
    requireApiKey: true,
    BASE_URL: "https://api.openai.com/v1",
    DEFAULT_CHAT_MODEL: "gpt-3.5-turbo"
  },
  {
    MODEL_PROVIDER: "Gemini",
    requireApiKey: true,
    BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    DEFAULT_CHAT_MODEL: "models/gemini-2.0-flash-exp"
  },
  {
    MODEL_PROVIDER: "Groq",
    requireApiKey: true,
    BASE_URL: "https://api.groq.com/openai/v1",
    DEFAULT_CHAT_MODEL: "deepseek-r1-distill-llama-70b"
  },
  {
    MODEL_PROVIDER: "Requesty",
    requireApiKey: true,
    BASE_URL: "https://router.requesty.ai/v1",
    DEFAULT_CHAT_MODEL: "google/gemini-2.0-flash-exp"
  },
  {
    MODEL_PROVIDER: "OpenRouter",
    requireApiKey: true,
    BASE_URL: "https://openrouter.ai/api/v1",
    DEFAULT_CHAT_MODEL: "deepseek/deepseek-r1-distill-llama-70b"
  },
  {
    MODEL_PROVIDER: "NVIDIA",
    requireApiKey: true,
    BASE_URL: "https://integrate.api.nvidia.com/v1",
    DEFAULT_CHAT_MODEL: "moonshotai/kimi-k2-instruct"
  },
  {
    MODEL_PROVIDER: "AgentRouter",
    requireApiKey: true,
    BASE_URL: "https://agentrouter.org/v1",
    DEFAULT_CHAT_MODEL: "claude-sonnet-4-5-20250929"
  },
  {
    MODEL_PROVIDER: "GMICloud",
    requireApiKey: true,
    BASE_URL: "https://api.gmi-serving.com/v1",
    DEFAULT_CHAT_MODEL: "meta-llama/Llama-3.3-70B-Instruct"
  },
  {
    MODEL_PROVIDER: "ZenMux",
    requireApiKey: true,
    BASE_URL: "https://zenmux.ai/api/v1",
    DEFAULT_CHAT_MODEL: "openai/gpt-5"
  },
  {
    // OpenAI-compatible provider with a user-supplied base URL (self-hosted,
    // proxy, or any endpoint not listed above). BASE_URL is intentionally
    // empty here — the real value lives per-config in ModelConfig.baseUrl
    // and overrides this at every lookup site (see getLlmSettings.ts).
    MODEL_PROVIDER: "Custom",
    requireApiKey: true,
    BASE_URL: "",
    DEFAULT_CHAT_MODEL: ""
  }
];
var WORKER_STATUS = {
  PROCESSING: "processing",
  COMPLETED: "completed",
  ERROR: "error",
  PROCESSED: "processed"
};
var ATLASSIAN_OAUTH = {
  ATLASSIAN_CLIENT_ID: "zP9e8TO6Rf7DIsVRtkbPJa2yi8WOeKGJ",
  // Token exchange is proxied through a Vercel function that holds the client_secret securely
  TOKEN_PROXY_URL: "https://workspace-gpt-confluence-auth-proxy.vercel.app/api/token",
  AUTH_URL: "https://auth.atlassian.com/authorize",
  TOKEN_URL: "https://auth.atlassian.com/oauth/token",
  ACCESSIBLE_RESOURCES_URL: "https://api.atlassian.com/oauth/token/accessible-resources",
  SCOPES: [
    "read:space:confluence",
    "search:confluence",
    "read:confluence-space.summary",
    "read:confluence-content.summary",
    "read:confluence-content.all",
    "read:page:confluence",
    "offline_access"
  ],
  CALLBACK_PORT: 32323,
  CALLBACK_PATH: "/callback"
};
var ADO_AZURE_CLI = {
  /** Azure DevOps resource id — same GUID Microsoft's own tooling requests tokens for. */
  RESOURCE_ID: "499b84ac-1321-427f-aa17-267ca6975798"
};
var ADO_MSAL = {
  /**
   * Well-known public client id for Microsoft's official `@azure-devops/mcp`
   * server (microsoft/azure-devops-mcp, src/auth.ts). Not ours — see the
   * doc comment above for what that means and why it's used anyway.
   */
  CLIENT_ID: "0d50963b-7bb9-4fe7-94c7-a99af00b5136",
  AUTHORITY: "https://login.microsoftonline.com/common",
  /** Azure DevOps resource id — same GUID as ADO_AZURE_CLI.RESOURCE_ID. */
  RESOURCE_ID: "499b84ac-1321-427f-aa17-267ca6975798"
};
var GITHUB_OAUTH = {
  CLIENT_ID: "Ov23liuwYl36ZVETh3Nk",
  AUTH_URL: "https://github.com/login/oauth/authorize",
  TOKEN_PROXY_URL: "https://workspace-gpt-confluence-auth-proxy.vercel.app/api/github/oauth-token",
  API_BASE: "https://api.github.com",
  SCOPES: ["repo", "workflow"],
  CALLBACK_PORT: 32325,
  CALLBACK_PATH: "/callback"
};
var GITHUB_APP = {
  // Public slug from github.com/apps/<slug>. Set after registering the App.
  APP_SLUG: "REPLACE_WITH_GITHUB_APP_SLUG",
  INSTALL_BASE_URL: "https://github.com/apps",
  // Proxy that holds the private key and mints installation tokens.
  INSTALLATION_TOKEN_PROXY_URL: "https://workspace-gpt-confluence-auth-proxy.vercel.app/api/github/installation-token",
  API_BASE: "https://api.github.com",
  CALLBACK_PORT: 32325,
  CALLBACK_PATH: "/callback"
};
var REMOTE_AUTH = {
  API_BASE: "http://127.0.0.1:8787",
  CALLBACK_PORT: 32329,
  CALLBACK_PATH: "/callback"
};
var REMOTE_INFERENCE_BASE_URL = `${REMOTE_AUTH.API_BASE}/v1`;
var GITHUB_API_BASE = "https://api.github.com";
var EMPTY_MACH_REPO = {
  apiBase: GITHUB_API_BASE,
  monorepoOwner: "",
  monorepoRepo: "",
  monorepoRef: "main",
  workflowName: "",
  destOwner: "",
  repoTemplate: ""
};
function renderRepoName(template, brand, env) {
  return template.replace(/\{brand\}/g, brand).replace(/\{env\}/g, env);
}
function hasLegacyDeploymentFields(d) {
  return !!(d.rosterPageUrl || d.vercelProjectId || d.vercelProjectName || d.machBrand || d.machRepo || d.machSourceEnv || Array.isArray(d.environments) && d.environments.length);
}
function legacyToDescriptor(dep) {
  const d = dep ?? {};
  if (!hasLegacyDeploymentFields(d)) {
    return { name: "Custom", source: { provider: "none" }, stages: [] };
  }
  return {
    name: "Custom",
    environments: Array.isArray(d.environments) ? d.environments : void 0,
    source: {
      provider: "confluence-roster",
      rosterPageUrl: d.rosterPageUrl ?? "",
      rosterColumns: d.rosterColumns,
      // Preserve the raw value (undefined stays undefined) so both flags keep
      // their default-ON semantics; only an explicit stored `false` disables.
      aiAssistParsing: d.aiAssistParsing,
      aiConfigSync: d.aiConfigSync
    },
    stages: [
      {
        name: "Frontend",
        gate: "manual",
        actions: [
          {
            id: "vercel",
            provider: "vercel-config",
            category: "deploy",
            config: {
              projectId: d.vercelProjectId ?? "",
              projectName: d.vercelProjectName ?? "",
              envStage: d.vercelEnvStage ?? "preview",
              envProd: d.vercelEnvProd ?? "production",
              perEnvValues: !!d.vercelPerEnvValues
            }
          }
        ]
      },
      {
        name: "Backend",
        gate: "manual",
        actions: [
          {
            id: "mach",
            provider: "github-workflow-dispatch",
            category: "deploy",
            config: {
              repo: { ...EMPTY_MACH_REPO, ...d.machRepo ?? {} },
              brand: d.machBrand ?? "",
              sourceEnv: d.machSourceEnv ?? "",
              fromBranch: d.machFromBranch ?? "main",
              envStage: d.machEnvStage ?? "stage",
              envProd: d.machEnvProd ?? "prod",
              updateMainYml: d.machUpdateMainYml !== false,
              renamePrTitle: true,
              versionInjection: { enabled: !!d.vercelProjectId, component: "webapp", vercelProjectId: d.vercelProjectId ?? "" }
            }
          }
        ]
      }
    ]
  };
}
function ensureId(p) {
  return p.id ? p : { ...p, id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
}
function resolvePresetList(dep) {
  if (Array.isArray(dep?.pipelines) && dep.pipelines.length) {
    return dep.pipelines.map(ensureId);
  }
  const single = dep?.pipeline ? dep.pipeline : legacyToDescriptor(dep ?? {});
  return [ensureId(single)];
}
function resolveActivePipeline(dep) {
  const list = resolvePresetList(dep);
  return list.find((p) => p.id === dep?.activePipelineId) ?? list[0];
}
function sanitizeImportedPipeline(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const r = raw;
  return {
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Imported preset",
    source: r.source && typeof r.source === "object" ? r.source : { provider: "none" },
    stages: Array.isArray(r.stages) ? r.stages : [],
    environments: Array.isArray(r.environments) ? r.environments : void 0,
    hotfix: r.hotfix && typeof r.hotfix === "object" ? r.hotfix : void 0
  };
}
function uniqueName(base, existing, excludeId) {
  const taken = new Set(existing.filter((p) => p.id !== excludeId).map((p) => p.name));
  if (!taken.has(base))
    return base;
  let n = 2;
  while (taken.has(`${base} (${n})`))
    n++;
  return `${base} (${n})`;
}
var VERCEL_OAUTH = {
  CLIENT_ID: "oac_HBVNdJktT9K9b7IJDEf3D1Kv",
  // Integration slug from vercel.com/integrations/<slug>.
  INTEGRATION_SLUG: "workspacegpt-deploy",
  AUTH_BASE_URL: "https://vercel.com/integrations",
  TOKEN_PROXY_URL: "https://workspace-gpt-confluence-auth-proxy.vercel.app/api/vercel/token",
  API_BASE: "https://api.vercel.com",
  CALLBACK_PORT: 32326,
  CALLBACK_PATH: "/callback"
};
var ModelTypeEnum = /* @__PURE__ */ ((ModelTypeEnum2) => {
  ModelTypeEnum2["Chat"] = "chat";
  ModelTypeEnum2["Embedding"] = "embedding";
  return ModelTypeEnum2;
})(ModelTypeEnum || {});
var SYNC_INTERVAL_MS = 15 * 60 * 1e3;
var UPDATE_CHECK = {
  OPEN_VSX_API_URL: "https://open-vsx.org/api/Riteshkant/workspacegpt-extension",
  RELEASES_URL: "https://github.com/ritesh-kant/workspaceGPT/releases/tag/workspaceGPT-v",
  EXTENSION_ID: "Riteshkant.workspacegpt-extension",
  // Re-check periodically for long-lived windows; a fresh check also always
  // runs once per activation (delayed so it never competes with startup work).
  CHECK_INTERVAL_MS: 12 * 60 * 60 * 1e3,
  // 12 hours
  FIRST_CHECK_DELAY_MS: 30 * 1e3,
  // 30 seconds
  REQUEST_TIMEOUT_MS: 5 * 1e3
};
export {
  ADO_AZURE_CLI,
  ADO_MSAL,
  ATLASSIAN_OAUTH,
  ATTACHMENT_LIMITS,
  EMPTY_MACH_REPO,
  EXTENSION,
  GITHUB_API_BASE,
  GITHUB_APP,
  GITHUB_OAUTH,
  MENTION_LIMITS,
  MESSAGE_TYPES,
  MODEL,
  MODEL_PROVIDERS,
  ModelTypeEnum,
  REMOTE_AUTH,
  REMOTE_INFERENCE_BASE_URL,
  REMOTE_MODEL,
  RETRIEVAL_THRESHOLDS,
  SEARCH_CONSTANTS,
  SIDEBAR_MIN_WIDTH_PX,
  STORAGE_KEYS,
  SYNC_INTERVAL_MS,
  UPDATE_CHECK,
  VERCEL_OAUTH,
  WORKER_STATUS,
  legacyToDescriptor,
  normalizeQdrantUrl,
  renderRepoName,
  resolveActivePipeline,
  resolvePresetList,
  sanitizeImportedPipeline,
  uniqueName
};
