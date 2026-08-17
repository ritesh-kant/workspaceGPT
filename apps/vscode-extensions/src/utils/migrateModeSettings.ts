import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../constants';
import { inferModeFromLegacyConfig } from './getModeSettings';

/**
 * One-time upgrade for installs that predate the mode switch: stamps
 * `config.mode` (inferred from the existing embedding/vector-store settings)
 * and marks onboarding as already completed, so nobody who already has a
 * working setup gets sent through the first-run flow. Fresh installs have no
 * settings blob yet and are left untouched — onboarding creates one with
 * `mode`/`onboardingCompleted` already set on Finish.
 *
 * Mutates the existing blob in place and writes it back so the zustand
 * `version` field (and everything else in `state.config`) survives untouched.
 */
export async function migrateModeSettings(context: vscode.ExtensionContext): Promise<void> {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  if (!settings?.state?.config) return;
  const config = settings.state.config;
  if (config.mode === 'local' || config.mode === 'remote') return;

  config.mode = inferModeFromLegacyConfig(settings);
  config.onboardingCompleted = true;
  await context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
}
