import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { postToWebview } from './webviewBroadcast';

export type SyncSection = 'confluence' | 'ado' | 'jira';

export const SYNC_SECTIONS: readonly SyncSection[] = ['confluence', 'ado', 'jira'];

/** The subset of a section's config that describes sync progress over time. */
export interface SyncStatePatch {
  /** Incremental-sync watermark. ISO string, or '' to force a full re-sync. */
  lastSyncTime?: string;
  isSyncing?: boolean;
  isIndexing?: boolean;
  /** The index is usable. Set when an indexing worker finishes, whoever started it. */
  isIndexingCompleted?: boolean;
}

/**
 * Sync fields the extension host is the single writer for.
 *
 * The webview settings store and the host both persist into
 * `STORAGE_KEYS.SETTINGS`, and the webview writes the *whole* blob at once
 * (see settingsStore's `vscodeStorage.setItem`). Because the store hydrates
 * from global state only once, its copy of these fields goes stale as soon as
 * a background sync runs — and any unrelated settings edit then wrote that
 * stale copy back, rolling `lastSyncTime` backwards and making the next sync
 * re-fetch a window that was already indexed.
 *
 * `preserveHostOwnedSyncFields` keeps the persisted values for these keys and
 * discards whatever the webview sent, so the webview can no longer clobber
 * them. Every transition is therefore driven from the host: sync start/finish
 * in the message handlers and schedulers, indexing start in the sync-complete
 * callbacks, indexing finish in the embedding services' worker handlers.
 *
 * The `_needsResume*` flags are here for the same reason even though they never
 * reach the UI: only the host reads or writes them (crash recovery in the
 * schedulers, consumption in `checkAndSync`), so a
 * webview blob write could either drop a pending resume or resurrect one the
 * host had just consumed. The webview's own resume state is `canResume` /
 * `canResumeIndexing`, which it does own.
 */
export const HOST_OWNED_SYNC_FIELDS = [
  'lastSyncTime',
  'isSyncing',
  'isIndexing',
  'isIndexingCompleted',
  '_needsResume',
  '_needsResumeIndexing',
] as const;

/**
 * When a section's index was last brought up to date, as an ISO string.
 *
 * Read-only counterpart to persistSyncState, for callers that must tell the
 * difference between "the index says no" and "the index has not seen this
 * yet". On ticket #1536998 the run was asked to read a design doc created the
 * same day; the docs index had last synced a week earlier, so search_docs
 * answered confidently from a copy that could not contain it, and the report
 * never mentioned the gap.
 */
export function readLastSyncTime(
  context: vscode.ExtensionContext,
  section: SyncSection
): string | undefined {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const value = settings?.state?.config?.[section]?.lastSyncTime;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Write sync state into global state without telling the webview. Prefer
 * publishSyncState: the schedulers' services now report progress to the panel
 * and share their worker with its Stop button, so a background run has no
 * reason to be hidden.
 */
export async function persistSyncState(
  context: vscode.ExtensionContext,
  section: SyncSection,
  patch: SyncStatePatch
): Promise<void> {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const sectionConfig = settings?.state?.config?.[section];
  if (!sectionConfig) return;

  Object.assign(sectionConfig, patch);
  await context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
}

/**
 * Write sync state and push it to the webview.
 *
 * The push is what keeps the "synced Nh ago" label honest. The settings store
 * reads global state exactly once (zustand `persist` calls `getItem` at store
 * creation) and `retainContextWhenHidden` keeps the panel alive indefinitely,
 * so a sync that only wrote global state would leave the label frozen at
 * whatever it read on hydration.
 */
export async function publishSyncState(
  context: vscode.ExtensionContext,
  section: SyncSection,
  patch: SyncStatePatch
): Promise<void> {
  await persistSyncState(context, section, patch);
  postToWebview({
    type: MESSAGE_TYPES.BACKGROUND_SYNC_STATE,
    section,
    ...patch,
  });
}

/**
 * Overlay the persisted host-owned sync fields onto a settings blob arriving
 * from the webview, so a stale webview copy can't overwrite them. Mutates and
 * returns `incoming` — it is already a fresh object deserialized from the
 * message.
 */
export function preserveHostOwnedSyncFields(
  context: vscode.ExtensionContext,
  incoming: any
): any {
  const persisted = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const persistedConfig = persisted?.state?.config;
  const incomingConfig = incoming?.state?.config;
  if (!persistedConfig || !incomingConfig) return incoming;

  for (const section of SYNC_SECTIONS) {
    const from = persistedConfig[section];
    const to = incomingConfig[section];
    if (!from || !to) continue;

    for (const field of HOST_OWNED_SYNC_FIELDS) {
      if (field in from) {
        to[field] = from[field];
      } else {
        delete to[field];
      }
    }
  }

  return incoming;
}
