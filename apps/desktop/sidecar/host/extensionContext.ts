/**
 * The `vscode.ExtensionContext` the real activate() receives.
 *
 * Only the members apps/vscode-extensions/src reads are defined (globalState,
 * workspaceState, secrets, globalStorageUri, subscriptions, extensionUri,
 * asAbsolutePath, extensionMode, extension); reading anything else throws
 * NotSupportedInDesktop, same rule as the compat namespaces.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ExtensionMode, Uri } from '../vscode-compat/types';
import { NotSupportedInDesktop, recordNotSupported } from '../vscode-compat/notSupported';
import { ownExtension } from '../vscode-compat/env';
import { JsonStore, memento, workspaceStateFile, type AppPaths } from './stores';
import { createSecretStorage } from './secrets';

export interface DesktopContext {
  context: any;
  globalState: JsonStore;
  workspaceState: JsonStore;
  secretsBackend: 'keychain' | 'memory';
  dispose(): Promise<void>;
}

export function createExtensionContext(opts: { paths: AppPaths; extensionDir: string; workspaceFolder?: string }): DesktopContext {
  const { paths, extensionDir } = opts;
  const globalState = new JsonStore(paths.stateFile);
  const workspaceState = new JsonStore(workspaceStateFile(paths, opts.workspaceFolder));
  const secrets = createSecretStorage();
  const subscriptions: { dispose(): any }[] = [];
  const workspaceStorage = path.join(paths.root, 'workspace-storage', path.basename(workspaceStateFile(paths, opts.workspaceFolder), '.json'));
  fs.mkdirSync(workspaceStorage, { recursive: true });

  const impl: Record<string, unknown> = {
    subscriptions,
    extensionUri: Uri.file(extensionDir),
    extensionPath: extensionDir,
    asAbsolutePath: (rel: string) => path.join(extensionDir, rel),
    globalState: memento(globalState),
    workspaceState: memento(workspaceState),
    secrets: secrets.storage,
    globalStorageUri: Uri.file(paths.storageDir),
    globalStoragePath: paths.storageDir,
    storageUri: Uri.file(workspaceStorage),
    storagePath: workspaceStorage,
    logUri: Uri.file(paths.logDir),
    logPath: paths.logDir,
    // Production: the extension's Development branch watches webview/dist for
    // hot reload, which the desktop's dev loop does differently.
    extensionMode: ExtensionMode.Production,
    get extension() {
      return ownExtension();
    },
  };

  const context = new Proxy(impl, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
      if (prop === 'then' || prop === 'toJSON') return undefined;
      const api = `ExtensionContext.${prop}`;
      recordNotSupported(api);
      throw new NotSupportedInDesktop(api);
    },
  });

  return {
    context,
    globalState,
    workspaceState,
    secretsBackend: secrets.backendKind,
    async dispose() {
      for (const d of subscriptions.splice(0).reverse()) {
        try {
          await d?.dispose();
        } catch (err) {
          console.error('[desktop] disposing a subscription threw:', err);
        }
      }
      globalState.flushSync();
      workspaceState.flushSync();
    },
  };
}
