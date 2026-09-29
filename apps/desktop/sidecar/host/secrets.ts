/**
 * `context.secrets` backed by the OS credential store via @napi-rs/keyring
 * (challenge #10 — keytar is archived). One service name per profile (see
 * secretServiceFor below); the account is the extension's own secret key, so
 * names match the extension's.
 *
 * If the native module can't load, or WGPT_DESKTOP_SECRETS=memory is set
 * (CI, throwaway test profiles), secrets live in memory for this run only and
 * the sidecar says so at startup — sign-in then lasts until quit.
 *
 * Windows: Credential Manager caps a blob at 2560 bytes (1280 UTF-16 units),
 * and the extension stores larger values (the ADO MSAL cache is ~32 KB), so
 * there values are split across entries (chunked() below). macOS Keychain and
 * the Linux Secret Service have no such limit and store every value whole.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from '../vscode-compat/types';
import { defaultAppRoot } from './stores';

export const SECRET_SERVICE = 'WorkspaceGPT Desktop';

/**
 * The keychain service for a profile's data root. The installed app's profile
 * (defaultAppRoot) keeps SECRET_SERVICE unchanged, so existing installs read
 * the items they already have, with no new keychain prompt (NOTES.md,
 * "Keychain"). Any other root (--data-dir, WGPT_DESKTOP_DATA_DIR: dev and test
 * profiles) gets `WorkspaceGPT Desktop (<8 hex of sha256(real path)>)`, so its
 * Sign out, Reset or API-key save can't touch the installed app's items.
 * Roots are compared by real path, so a symlink, `..` or a differently cased
 * spelling of the default root still counts as the default.
 */
export function secretServiceFor(root: string, defaultRoot: string = defaultAppRoot()): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const r = real(root);
  if (r === real(defaultRoot)) return SECRET_SERVICE;
  return `${SECRET_SERVICE} (${crypto.createHash('sha256').update(r).digest('hex').slice(0, 8)})`;
}

export interface Backend {
  kind: 'keychain' | 'memory';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function memoryBackend(): Backend {
  const m = new Map<string, string>();
  return {
    kind: 'memory',
    get: async (k) => m.get(k),
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

function keyringBackend(service: string): Backend {
  // Required lazily so a missing prebuilt binary degrades instead of crashing startup.
  const { AsyncEntry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
  const entry = (key: string) => new AsyncEntry(service, key);
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

/** Under Credential Manager's 1280 UTF-16 units, with room for nothing else in the blob. */
const WINDOWS_CHUNK_UNITS = 1200;
const CHUNK_HEADER = 'wgpt-chunked:v1:';

/** Split without cutting a surrogate pair: the native side converts to UTF-8, where half a pair is corrupted. */
export function splitForChunks(value: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < value.length; ) {
    let end = Math.min(i + size, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(value.slice(i, end));
    i = end;
  }
  return parts;
}

/**
 * A value longer than `size` is stored as `<key>#<gen>#<i>` chunks plus a
 * header `wgpt-chunked:v1:<gen>:<count>` under `<key>` itself. Values that
 * fit are stored unchanged, so entries written before chunking existed still
 * read. The header is written last and the previous generation's chunks are
 * removed after it, so a reader sees either the old value or the new one,
 * never a mix.
 */
export function chunked(inner: Backend, size: number): Backend {
  const parseHeader = (v: string | undefined) => {
    const m = v?.startsWith(CHUNK_HEADER) ? /^wgpt-chunked:v1:([a-z0-9]+):(\d+)$/.exec(v) : null;
    return m ? { gen: m[1]!, count: Number(m[2]) } : undefined;
  };
  const chunkKey = (key: string, gen: string, i: number) => `${key}#${gen}#${i}`;
  const dropChunks = async (key: string, h: { gen: string; count: number } | undefined) => {
    if (!h) return;
    for (let i = 0; i < h.count; i++) await inner.delete(chunkKey(key, h.gen, i));
  };
  return {
    kind: inner.kind,
    async get(key) {
      const head = await inner.get(key);
      const h = parseHeader(head);
      if (!h) return head;
      const parts: string[] = [];
      for (let i = 0; i < h.count; i++) {
        const part = await inner.get(chunkKey(key, h.gen, i));
        // A missing chunk means the entry is damaged; say "no secret" rather than hand back a truncated token.
        if (part === undefined) {
          console.warn(`[desktop] secret ${key}: chunk ${i + 1} of ${h.count} is missing — treating it as unset`);
          return undefined;
        }
        parts.push(part);
      }
      return parts.join('');
    },
    async set(key, value) {
      const previous = parseHeader(await inner.get(key));
      if (value.length <= size && !value.startsWith(CHUNK_HEADER)) {
        await inner.set(key, value);
      } else {
        const gen = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const parts = splitForChunks(value, size);
        for (let i = 0; i < parts.length; i++) await inner.set(chunkKey(key, gen, i), parts[i]!);
        await inner.set(key, `${CHUNK_HEADER}${gen}:${parts.length}`);
      }
      await dropChunks(key, previous);
    },
    async delete(key) {
      const h = parseHeader(await inner.get(key));
      await inner.delete(key);
      await dropChunks(key, h);
    },
  };
}

/** `service`: secretServiceFor(<data root>), or an explicit --secrets-service; never a bare constant. */
export function createSecretStorage(service: string) {
  let backend: Backend;
  if (process.env.WGPT_DESKTOP_SECRETS === 'memory') {
    backend = memoryBackend();
  } else {
    try {
      backend = keyringBackend(service);
    } catch (err) {
      console.warn('[desktop] OS keychain unavailable, secrets are in memory for this run only:', err);
      backend = memoryBackend();
    }
  }
  // WGPT_DESKTOP_SECRETS_CHUNK=<units> exercises the Windows path on any OS (tests).
  const chunkUnits = Number(process.env.WGPT_DESKTOP_SECRETS_CHUNK) || (process.platform === 'win32' ? WINDOWS_CHUNK_UNITS : 0);
  if (chunkUnits > 0) backend = chunked(backend, chunkUnits);
  const changed = new EventEmitter<{ key: string }>();
  return {
    backendKind: backend.kind,
    service,
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
