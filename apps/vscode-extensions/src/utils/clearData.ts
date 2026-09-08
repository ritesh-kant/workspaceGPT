import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { STORAGE_KEYS } from '../../constants';
import { setCachedRemoteSessionToken } from '../services/remote/remoteSessionCache';
import { deleteDirectory } from './deleteDirectory';

const STORAGE_DIRECTORIES = [
  'confluence',
  'ado',
  'codebase',
  'chats',
  'checkpoints',
  'agent-resume',
];

const STORAGE_FILES = ['agent-actions.jsonl', 'deployment-runs.jsonl'];

const SECRET_KEYS = [
  STORAGE_KEYS.CONFLUENCE_OAUTH_TOKENS,
  STORAGE_KEYS.ADO_AUTH_MODE,
  STORAGE_KEYS.ADO_PAT,
  STORAGE_KEYS.ADO_MSAL_CACHE,
  STORAGE_KEYS.GITHUB_OAUTH_TOKENS,
  STORAGE_KEYS.GITHUB_APP_INSTALLATION,
  STORAGE_KEYS.GITHUB_INSTALLATION_TOKEN_CACHE,
  STORAGE_KEYS.VERCEL_OAUTH_TOKENS,
  STORAGE_KEYS.GITHUB_MACH_PAT,
  STORAGE_KEYS.REMOTE_SESSION_TOKEN,
];

export async function clearWorkspaceGPTData(context: vscode.ExtensionContext): Promise<void> {
  // 1. Delete every extension-owned file/directory that can contain user data.
  for (const dir of STORAGE_DIRECTORIES) {
    const dirPath = path.join(context.globalStorageUri.fsPath, dir);
    await deleteDirectory(dirPath);
  }
  await Promise.all(
    STORAGE_FILES.map((file) =>
      fs.rm(path.join(context.globalStorageUri.fsPath, file), { force: true })
    )
  );

  // 2. Clear all credentials, including integrations not represented by an
  // active webview handler. SecretStorage is separate from globalState.
  await Promise.all(SECRET_KEYS.map((key) => context.secrets.delete(key)));
  setCachedRemoteSessionToken(undefined);

  // 3. Clear entire global state.
  const keys = context.globalState.keys();
  for (const key of keys) {
    await context.globalState.update(key, undefined);
  }

  console.log('WorkspaceGPT data and cache cleared entirely.');
}
