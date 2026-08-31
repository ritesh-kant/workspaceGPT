import * as vscode from 'vscode';
import { STORAGE_KEYS, WorkspaceMode } from '../../constants';

/**
 * True for installs configured before indexing was decoupled from the mode
 * switch — Gemini embeddings + a Qdrant cloud index. Those two axes are no
 * longer reachable (the index is always local now), so such an install's
 * vectors live in a store the extension will never query again and it needs
 * one re-sync. Used only by {@link migrateModeSettings} to say so once.
 */
export function hadCloudIndex(settings: any): boolean {
  const emb = settings?.state?.config?.embedding;
  const vs = settings?.state?.config?.vectorStore;
  return emb?.provider === 'gemini' && vs?.location === 'cloud';
}

/**
 * The single source of truth for local-vs-remote — which, since indexing was
 * decoupled from it, means only one thing: where chat inference comes from.
 *
 * Falls back to `local` when `config.mode` is absent. That is the
 * least-disruptive landing for a pre-mode-switch install: `remote` would
 * demand an account before the user could ask anything, while `local` keeps
 * using the provider keys they already have.
 */
export function getMode(context: vscode.ExtensionContext): WorkspaceMode {
  const settings = context.globalState.get(STORAGE_KEYS.SETTINGS) as any;
  const mode = settings?.state?.config?.mode;
  if (mode === 'remote' || mode === 'local') return mode;
  return 'local';
}
