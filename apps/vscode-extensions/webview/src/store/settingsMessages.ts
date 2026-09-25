import { useSettingsStore } from './settingsStore';
import { MESSAGE_TYPES } from '../constants';
import { clearStatusMessageAfterDelay } from './statusMessage';

/**
 * Host → webview handling for the Confluence and Azure DevOps integrations.
 *
 * This lives at app scope rather than inside the settings components on
 * purpose: the Settings panel unmounts whenever the user goes back to chat, and
 * terminal events (sync complete, sync error, OAuth success) are sent exactly
 * once. With the listener owned by the panel, a sync that finished while the
 * user was reading a chat left the store stuck at "Syncing… 73%" with the wrong
 * buttons until something else happened to correct it. Progress ticks used to
 * paper over this because they repeat; completions never do.
 *
 * Registered once from main.tsx, before React mounts.
 */

function handleConfluenceMessage(message: any): void {
  const batchUpdateConfig = useSettingsStore.getState().batchUpdateConfig;

  switch (message.type) {
    // OAuth
    case MESSAGE_TYPES.CONFLUENCE_OAUTH_SUCCESS:
      batchUpdateConfig('confluence', {
        isAuthenticated: true,
        isConnecting: false,
        siteName: message.site?.name || '',
        cloudId: message.site?.id || '',
        messageType: 'success',
        statusMessage: `Connected to ${message.site?.name || 'Confluence'}`,
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    case MESSAGE_TYPES.CONFLUENCE_OAUTH_ERROR:
      batchUpdateConfig('confluence', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Authentication failed',
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    case MESSAGE_TYPES.DISCONNECT_CONFLUENCE:
      batchUpdateConfig('confluence', {
        isAuthenticated: false,
        siteName: '',
        cloudId: '',
        spaceKey: '',
        availableSpaces: [],
        isSyncing: false,
        isIndexing: false,
        canResume: false,
        canResumeIndexing: false,
        isSyncCompleted: false,
        isIndexingCompleted: false,
        confluenceSyncProgress: 0,
        confluenceIndexProgress: 0,
        lastSyncTime: '',
        messageType: 'success',
        statusMessage: 'Disconnected from Confluence',
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    case MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES_RESPONSE:
      batchUpdateConfig('confluence', {
        availableSpaces: message.spaces || [],
      });
      break;

    case MESSAGE_TYPES.FETCH_CONFLUENCE_SPACES_ERROR:
      batchUpdateConfig('confluence', {
        messageType: 'error',
        statusMessage: message.message || 'Failed to fetch spaces',
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    // Connection check
    case MESSAGE_TYPES.CONFLUENCE_CONNECTION_STATUS:
      batchUpdateConfig('confluence', {
        messageType: message.status ? 'success' : 'error',
        statusMessage: message.message || '',
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    // Sync
    case MESSAGE_TYPES.SYNC_CONFLUENCE_IN_PROGRESS:
      batchUpdateConfig('confluence', {
        confluenceSyncProgress: message.progress,
        messageType: 'success',
        isSyncing: message.progress < 100,
        canResume: true,
      });
      break;

    case MESSAGE_TYPES.SYNC_CONFLUENCE_COMPLETE:
      batchUpdateConfig('confluence', {
        messageType: 'success',
        statusMessage: 'Sync completed successfully',
        confluenceSyncProgress: 100,
        isSyncing: false,
        canResume: false,
        isSyncCompleted: true,
        lastSyncTime: message.lastSyncTime || new Date().toISOString(),
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    case MESSAGE_TYPES.SYNC_CONFLUENCE_ERROR:
      batchUpdateConfig('confluence', {
        isSyncing: false,
        messageType: 'error',
        statusMessage: 'Sync error: Please verify your connection and try again.',
        canResume: true,
      });
      break;

    case MESSAGE_TYPES.SYNC_CONFLUENCE_STOP:
      batchUpdateConfig('confluence', {
        isSyncing: false,
        messageType: 'error',
        statusMessage: 'Sync stopped',
        canResume: true,
      });
      break;

    // Indexing
    case MESSAGE_TYPES.INDEXING_CONFLUENCE_IN_PROGRESS:
      batchUpdateConfig('confluence', {
        confluenceIndexProgress: message.progress,
        messageType: 'success',
        isIndexing: true,
        canResumeIndexing: true,
        isSyncing: false,
        canResume: false,
      });
      break;

    case MESSAGE_TYPES.INDEXING_CONFLUENCE_COMPLETE:
      batchUpdateConfig('confluence', {
        confluenceIndexProgress: 100,
        messageType: 'success',
        isIndexing: false,
        statusMessage: 'Indexing completed successfully',
        canResumeIndexing: false,
        isSyncing: false,
        canResume: false,
        isIndexingCompleted: true,
      });
      clearStatusMessageAfterDelay('confluence');
      break;

    case MESSAGE_TYPES.INDEXING_CONFLUENCE_ERROR:
      batchUpdateConfig('confluence', {
        isSyncing: false,
        isIndexing: false,
        messageType: 'error',
        statusMessage: `Indexing error: ${message.message}`,
        canResumeIndexing: true,
      });
      break;
  }
}

function handleAdoMessage(message: any): void {
  const batchUpdateConfig = useSettingsStore.getState().batchUpdateConfig;

  switch (message.type) {
    case MESSAGE_TYPES.ADO_MSAL_SUCCESS:
      batchUpdateConfig('ado', {
        isAuthenticated: true,
        isConnecting: false,
        messageType: 'success',
        statusMessage: 'Connected to Azure DevOps',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.ADO_MSAL_ERROR:
      batchUpdateConfig('ado', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Microsoft sign-in failed',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.ADO_AZURE_CLI_SUCCESS:
      batchUpdateConfig('ado', {
        isAuthenticated: true,
        isConnecting: false,
        messageType: 'success',
        statusMessage: 'Connected to Azure DevOps via Azure CLI',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.ADO_AZURE_CLI_ERROR:
      batchUpdateConfig('ado', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Azure CLI connection failed',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.ADO_PAT_SUCCESS:
      batchUpdateConfig('ado', {
        isAuthenticated: true,
        isConnecting: false,
        messageType: 'success',
        statusMessage: 'Connected to Azure DevOps',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.ADO_PAT_ERROR:
      batchUpdateConfig('ado', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Invalid Personal Access Token',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS_SUCCESS: {
      const organizations = message.organizations || [];
      const current = useSettingsStore.getState().config.ado;
      batchUpdateConfig('ado', {
        availableOrganizations: organizations,
        // Auto-pick the org when there's only one — the common case — so
        // the user never has to type or choose anything for this field.
        ...(organizations.length === 1 && !current?.orgName
          ? { orgName: organizations[0].accountName }
          : {}),
      });
      break;
    }

    case MESSAGE_TYPES.FETCH_ADO_ORGANIZATIONS_ERROR:
      // Soft failure — the org dropdown just stays empty and the user can
      // still type the name manually. Not surfaced as a status message so
      // it doesn't look like the connect itself failed.
      console.warn('ADO organizations fetch error:', message.message);
      break;

    case MESSAGE_TYPES.FETCH_ADO_PROJECTS_SUCCESS:
      batchUpdateConfig('ado', {
        isConnecting: false,
        messageType: 'success',
        statusMessage: 'Projects loaded successfully',
        availableProjects: message.projects || [],
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.FETCH_ADO_PROJECTS_ERROR:
      batchUpdateConfig('ado', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Failed to load projects',
        availableProjects: [],
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.DISCONNECT_ADO:
      batchUpdateConfig('ado', {
        isAuthenticated: false,
        orgName: '',
        projectName: '',
        availableOrganizations: [],
        availableProjects: [],
        userDisplayName: '',
        currentSprint: null,
        isSyncing: false,
        isIndexing: false,
        canResume: false,
        canResumeIndexing: false,
        isSyncCompleted: false,
        isIndexingCompleted: false,
        adoSyncProgress: 0,
        adoIndexProgress: 0,
        lastSyncTime: '',
        messageType: 'success',
        statusMessage: 'Disconnected from Azure DevOps',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    // Connection check
    case MESSAGE_TYPES.ADO_CONNECTION_STATUS:
      batchUpdateConfig('ado', {
        messageType: message.status ? 'success' : 'error',
        statusMessage: message.message || '',
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.FETCH_ADO_USER_IDENTITY_SUCCESS:
      batchUpdateConfig('ado', {
        userDisplayName: message.userDisplayName || '',
        currentSprint: message.currentSprint || null,
      });
      break;

    case MESSAGE_TYPES.FETCH_ADO_USER_IDENTITY_ERROR:
      console.warn('ADO user identity fetch error:', message.message);
      break;

    // Sync
    case MESSAGE_TYPES.SYNC_ADO_IN_PROGRESS:
      batchUpdateConfig('ado', {
        adoSyncProgress: message.progress,
        messageType: 'success',
        isSyncing: message.progress < 100,
        canResume: true,
      });
      break;

    case MESSAGE_TYPES.SYNC_ADO_COMPLETE:
      batchUpdateConfig('ado', {
        messageType: 'success',
        statusMessage: 'Sync completed successfully',
        adoSyncProgress: 100,
        isSyncing: false,
        canResume: false,
        isSyncCompleted: true,
        lastSyncTime: message.lastSyncTime || new Date().toISOString(),
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.SYNC_ADO_ERROR:
      batchUpdateConfig('ado', {
        isSyncing: false,
        messageType: 'error',
        statusMessage: 'Sync error: Please verify your connection and try again.',
        canResume: true,
      });
      break;

    case MESSAGE_TYPES.SYNC_ADO_STOP:
      batchUpdateConfig('ado', {
        isSyncing: false,
        messageType: 'error',
        statusMessage: 'Sync stopped',
        canResume: true,
      });
      break;

    // Indexing
    case MESSAGE_TYPES.INDEXING_ADO_IN_PROGRESS:
      batchUpdateConfig('ado', {
        adoIndexProgress: message.progress,
        messageType: 'success',
        isIndexing: true,
        canResumeIndexing: true,
        isSyncing: false,
        canResume: false,
      });
      break;

    case MESSAGE_TYPES.INDEXING_ADO_COMPLETE:
      batchUpdateConfig('ado', {
        adoIndexProgress: 100,
        messageType: 'success',
        isIndexing: false,
        statusMessage: 'Indexing completed successfully',
        canResumeIndexing: false,
        isSyncing: false,
        canResume: false,
        isIndexingCompleted: true,
      });
      clearStatusMessageAfterDelay('ado');
      break;

    case MESSAGE_TYPES.INDEXING_ADO_ERROR:
      batchUpdateConfig('ado', {
        isSyncing: false,
        isIndexing: false,
        messageType: 'error',
        statusMessage: `Indexing error: ${message.message}`,
        canResumeIndexing: true,
      });
      break;
  }
}

/**
 * Host → webview handling for Jira. A smaller set of cases than ADO's on
 * purpose — v1 has one auth mode and no sync/indexing/My Work yet (see
 * constants.ts's MESSAGE_TYPES comment for why); this grows alongside those
 * features, not ahead of them.
 */
function handleJiraMessage(message: any): void {
  const batchUpdateConfig = useSettingsStore.getState().batchUpdateConfig;

  switch (message.type) {
    case MESSAGE_TYPES.JIRA_OAUTH_SUCCESS:
      batchUpdateConfig('jira', {
        isAuthenticated: true,
        isConnecting: false,
        siteUrl: message.site?.url || '',
        accountId: message.accountId || '',
        displayName: message.displayName || '',
        messageType: 'success',
        statusMessage: `Connected to Jira${message.displayName ? ` as ${message.displayName}` : ''}`,
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.JIRA_OAUTH_ERROR:
      batchUpdateConfig('jira', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Authentication failed',
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.FETCH_JIRA_PROJECTS_SUCCESS:
      batchUpdateConfig('jira', {
        isConnecting: false,
        messageType: 'success',
        statusMessage: 'Projects loaded successfully',
        availableProjects: message.projects || [],
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.FETCH_JIRA_PROJECTS_ERROR:
      batchUpdateConfig('jira', {
        isConnecting: false,
        messageType: 'error',
        statusMessage: message.message || 'Failed to load projects',
        availableProjects: [],
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.DISCONNECT_JIRA:
      batchUpdateConfig('jira', {
        isAuthenticated: false,
        siteUrl: '',
        projectKey: '',
        projectName: '',
        availableProjects: [],
        accountId: '',
        displayName: '',
        messageType: 'success',
        statusMessage: 'Disconnected from Jira',
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.JIRA_CONNECTION_STATUS:
      batchUpdateConfig('jira', {
        messageType: message.status ? 'success' : 'error',
        statusMessage: message.message || '',
      });
      clearStatusMessageAfterDelay('jira');
      break;

    // Sync
    case MESSAGE_TYPES.SYNC_JIRA_IN_PROGRESS:
      batchUpdateConfig('jira', {
        jiraSyncProgress: message.progress,
        messageType: 'success',
        isSyncing: message.progress < 100,
        canResume: true,
      });
      break;

    case MESSAGE_TYPES.SYNC_JIRA_COMPLETE:
      batchUpdateConfig('jira', {
        messageType: 'success',
        statusMessage: 'Sync completed successfully',
        jiraSyncProgress: 100,
        isSyncing: false,
        canResume: false,
        isSyncCompleted: true,
        lastSyncTime: message.lastSyncTime || new Date().toISOString(),
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.SYNC_JIRA_ERROR:
      batchUpdateConfig('jira', {
        isSyncing: false,
        messageType: 'error',
        statusMessage: 'Sync error: Please verify your connection and try again.',
        canResume: true,
      });
      break;

    case MESSAGE_TYPES.SYNC_JIRA_STOP:
      batchUpdateConfig('jira', {
        isSyncing: false,
        messageType: 'error',
        statusMessage: 'Sync stopped',
        canResume: true,
      });
      break;

    // Indexing
    case MESSAGE_TYPES.INDEXING_JIRA_IN_PROGRESS:
      batchUpdateConfig('jira', {
        jiraIndexProgress: message.progress,
        messageType: 'success',
        isIndexing: true,
      });
      break;

    case MESSAGE_TYPES.INDEXING_JIRA_COMPLETE:
      batchUpdateConfig('jira', {
        messageType: 'success',
        jiraIndexProgress: 100,
        isIndexing: false,
        canResumeIndexing: false,
        isIndexingCompleted: true,
      });
      clearStatusMessageAfterDelay('jira');
      break;

    case MESSAGE_TYPES.INDEXING_JIRA_ERROR:
      batchUpdateConfig('jira', {
        isSyncing: false,
        isIndexing: false,
        messageType: 'error',
        statusMessage: `Indexing error: ${message.message}`,
        canResumeIndexing: true,
      });
      break;
  }
}

let registered = false;

/**
 * Host → webview push for the sync fields the host owns. Sent by the
 * schedulers (which write global state the store never re-reads) and by the
 * message handlers, so the "synced Nh ago" label tracks background runs
 * instead of staying frozen at whatever the store hydrated with.
 */
function handleBackgroundSyncState(message: any): void {
  if (message?.type !== MESSAGE_TYPES.BACKGROUND_SYNC_STATE) return;
  if (message.section !== 'confluence' && message.section !== 'ado' && message.section !== 'jira') return;

  const patch: Record<string, unknown> = {};
  for (const field of ['lastSyncTime', 'isSyncing', 'isIndexing', 'isIndexingCompleted'] as const) {
    if (message[field] !== undefined) patch[field] = message[field];
  }
  if (Object.keys(patch).length === 0) return;

  useSettingsStore.getState().batchUpdateConfig(message.section, patch);
}

/** Idempotent: React StrictMode and hot reloads must not double-apply updates. */
export function registerSettingsMessageListener(): void {
  if (registered) return;
  registered = true;

  window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data;
    if (!message?.type) return;
    handleBackgroundSyncState(message);
    handleConfluenceMessage(message);
    handleAdoMessage(message);
    handleJiraMessage(message);
  });
}
