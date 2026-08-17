import * as vscode from 'vscode';
import { STORAGE_KEYS, WorkspaceMode } from '../../constants';

/**
 * Best-effort mode for installs saved before the mode switch existed (or a
 * settings blob written by a not-yet-migrated webview): `remote` only when
 * both prior independent axes already pointed at the cloud, matching what
 * `shareToChrome.ts` has always required. Everything else defaults to `local`
 * so an existing on-device index keeps matching after upgrade.
 */
export function inferModeFromLegacyConfig(settings: any): WorkspaceMode {
  const emb = settings?.state?.config?.embedding;
  const vs = settings?.state?.config?.vectorStore;
  return emb?.provider === 'gemini' && vs?.location === 'cloud' ? 'remote' : 'local';
}

/**
 * The single source of truth for local-vs-remote. Reads the explicit
 * `config.mode` when present; otherwise falls back to legacy inference so
 * behavior is never undefined between "settings blob written" and "webview
 * has re-saved with the new field".
 */
export function getMode(context: vscode.ExtensionContext): WorkspaceMode {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const mode = settings?.state?.config?.mode;
  if (mode === 'remote' || mode === 'local') return mode;
  return inferModeFromLegacyConfig(settings);
}
