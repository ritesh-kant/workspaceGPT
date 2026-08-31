import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { hadCloudIndex } from './getModeSettings';

/**
 * One-time upgrade for installs that predate the mode switch: stamps
 * `config.mode` and marks onboarding as already completed, so nobody who
 * already has a working setup gets sent through the first-run flow. Fresh
 * installs have no settings blob yet and are left untouched — onboarding
 * creates one with `mode`/`onboardingCompleted` already set on Finish.
 *
 * Everyone lands on `local`, including installs that used to point at a cloud
 * index: `remote` now means "use WorkspaceGPT's managed model", which would
 * demand an account before the user could ask a single question, whereas their
 * own provider keys still work as-is in `local`. Those installs do lose access
 * to their Qdrant-hosted vectors (the index is on-device now), so they get a
 * one-time notice telling them to re-sync.
 *
 * Mutates the existing blob in place and writes it back so the zustand
 * `version` field (and everything else in `state.config`) survives untouched.
 */
export async function migrateModeSettings(context: vscode.ExtensionContext): Promise<void> {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  if (!settings?.state?.config) return;
  const config = settings.state.config;
  if (config.mode === 'local' || config.mode === 'remote') return;

  const cloudIndex = hadCloudIndex(settings);
  config.mode = 'local';
  config.onboardingCompleted = true;
  await context.globalState.update(STORAGE_KEYS.SETTINGS, settings);

  if (cloudIndex) {
    // Non-modal: activation must not block on an acknowledgement.
    void vscode.window.showInformationMessage(
      'WorkspaceGPT now keeps your search index on this machine, so your previous cloud (Qdrant) index is no longer used. ' +
        'Re-sync Confluence and Azure DevOps in Settings to rebuild it locally.',
    );
  }
}
