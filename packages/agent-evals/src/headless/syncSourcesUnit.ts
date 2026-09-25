// One bundle for the sync-source tests: the services and the broadcast
// registry must share a module instance, as they do in the extension host.
export { ConfluenceEmbeddingService } from '../../../../apps/vscode-extensions/src/services/confluence/confluenceEmbeddingService';
export { AdoEmbeddingService } from '../../../../apps/vscode-extensions/src/services/ado/adoEmbeddingService';
export { registerWebviewPoster } from '../../../../apps/vscode-extensions/src/utils/webviewBroadcast';
export { preserveHostOwnedSyncFields } from '../../../../apps/vscode-extensions/src/utils/syncStateStore';
export { ConfluenceSyncScheduler } from '../../../../apps/vscode-extensions/src/services/confluence/confluenceSyncScheduler';
