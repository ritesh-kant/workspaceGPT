/**
 * `context.secrets` backed by the OS credential store via @napi-rs/keyring
 * (challenge #10 — keytar is archived). One service name; the account is the
 * extension's own secret key, so names match the extension's.
 *
 * If the native module can't load, or WGPT_DESKTOP_SECRETS=memory is set
 * (CI, throwaway test profiles), secrets live in memory for this run only and
 * the sidecar says so at startup — sign-in then lasts until quit.
 *
 * Windows caveat for Phase 2: Credential Manager caps a blob at 2560 bytes;
 * the extension stores larger values (the ADO MSAL cache is ~32 KB), so they
 * will need chunking there. macOS Keychain has no such limit.
 */
import { EventEmitter } from '../vscode-compat/types';

export const SECRET_SERVICE = 'WorkspaceGPT Desktop';

interface Backend {
  kind: 'keychain' | 'memory';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function memoryBackend(): Backend {
  const m = new Map<string, string>();
  return {
    kind: 'memory',
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

function keyringBackend(): Backend {
  // Required lazily so a missing prebuilt binary degrades instead of crashing startup.
  const { AsyncEntry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  const entry = (key: string) => new AsyncEntry(SECRET_SERVICE, key);
  return {
    kind: 'keychain',
    get: async (k) => (await entry(k).getPassword()) ?? undefined,
    set: (k, v) => entry(k).setPassword(v),
    delete: async (k) => {
      try {
        await entry(k).deleteCredential();
      } catch {
        // Deleting a secret that was never stored is not an error for SecretStorage.
      }
    },
  };
}

export function createSecretStorage() {
  let backend: Backend;
  if (process.env.WGPT_DESKTOP_SECRETS === 'memory') {
    backend = memoryBackend();
  } else {
    try {
      backend = keyringBackend();
    } catch (err) {
      console.warn('[desktop] OS keychain unavailable, secrets are in memory for this run only:', err);
      backend = memoryBackend();
    }
  }
  const changed = new EventEmitter<{ key: string }>();
  return {
    backendKind: backend.kind,
    storage: {
      get: (key: string) => backend.get(key),
      store: async (key: string, value: string) => {
        await backend.set(key, value);
        changed.fire({ key });
      },
      delete: async (key: string) => {
        await backend.delete(key);
        changed.fire({ key });
      },
      onDidChange: changed.event,
    },
  };
}
