#!/usr/bin/env node
/**
 * The Windows secret chunking (sidecar/host/secrets.ts) against a fake
 * Credential Manager that rejects blobs over 1280 UTF-16 units, as the real
 * one does, and the per-profile keychain service name (secretServiceFor).
 * Runs on any OS: node scripts/secrets-chunk-test.mjs
 */
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-secrets-')), 'secrets.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'sidecar/host/secrets.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error', external: ['@napi-rs/keyring'] });
const { chunked, memoryBackend, splitForChunks, secretServiceFor, SECRET_SERVICE } = createRequire(import.meta.url)(out);

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failed++;
};

// Credential Manager: 2560 bytes = 1280 UTF-16 units per blob.
function strictBackend() {
  const inner = memoryBackend();
  const keys = new Set();
  return {
    keys,
    kind: 'keychain',
    get: (k) => inner.get(k),
    async set(k, v) {
      if (v.length > 1280) throw new Error(`blob of ${v.length} units exceeds 1280`);
      keys.add(k);
      await inner.set(k, v);
    },
    async delete(k) {
      keys.delete(k);
      await inner.delete(k);
    },
  };
}

const raw = strictBackend();
const store = chunked(raw, 1200);
const msal = JSON.stringify({ AccessToken: { a: 'x'.repeat(20_000) }, RefreshToken: { r: 'y'.repeat(12_000) } }); // ~32 KB

await store.set('ado.msal', msal);
check('32 KB value stores under the 1280-unit cap', true, `${raw.keys.size} entries`);
check('reads back identical', (await store.get('ado.msal')) === msal);

const small = 'ghp_short-token';
await store.set('github', small);
check('small value is stored whole (one entry, no header)', (await raw.get('github')) === small && (await store.get('github')) === small);

await raw.set('legacy', 'written-before-chunking');
check('an entry written before chunking still reads', (await store.get('legacy')) === 'written-before-chunking');

const before = raw.keys.size;
const msal2 = msal.replace(/x/g, 'z');
await store.set('ado.msal', msal2);
check('overwrite reads the new value', (await store.get('ado.msal')) === msal2);
check('overwrite removes the previous generation', raw.keys.size === before, `${before} → ${raw.keys.size}`);

await store.set('ado.msal', 'now-small');
check('shrinking to a small value drops every chunk', (await store.get('ado.msal')) === 'now-small' && ![...raw.keys].some((k) => k.startsWith('ado.msal#')));

await store.set('ado.msal', msal);
await store.delete('ado.msal');
check('delete removes header and chunks', (await store.get('ado.msal')) === undefined && ![...raw.keys].some((k) => k.startsWith('ado.msal')));

const emoji = '😀'.repeat(1500); // 3000 units, surrogate pairs straddle every 1200 boundary
const parts = splitForChunks(emoji, 1199);
check('no chunk ends inside a surrogate pair', parts.every((p) => !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)), `${parts.length} chunks`);
await store.set('emoji', emoji);
check('surrogate-heavy value round-trips', (await store.get('emoji')) === emoji);

await store.set('damaged', msal);
const chunkKey = [...raw.keys].find((k) => k.startsWith('damaged#'));
await raw.delete(chunkKey);
check('a missing chunk reads as unset, not a truncated token', (await store.get('damaged')) === undefined);

const spoof = 'wgpt-chunked:v1:abc:3';
await store.set('spoof', spoof);
check('a value that looks like a header is stored as data', (await store.get('spoof')) === spoof);

// Keychain service per profile. The installed app's root, spelled out here
// independently of stores.ts, must keep the name existing installs use.
check('the installed app keeps the service name', SECRET_SERVICE === 'WorkspaceGPT Desktop', SECRET_SERVICE);
const home = os.homedir();
const installedRoot =
  process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'WorkspaceGPT Desktop')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'WorkspaceGPT Desktop')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'workspacegpt-desktop');
check('default root → the old service name', secretServiceFor(installedRoot) === SECRET_SERVICE, secretServiceFor(installedRoot));
const respelled = path.join(installedRoot, '..', path.basename(installedRoot)) + path.sep;
check('default root spelled with .. and a trailing slash → the old name', secretServiceFor(respelled) === SECRET_SERVICE);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-profile-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-profile-'));
const derived = secretServiceFor(scratch);
check('another root → a derived name', /^WorkspaceGPT Desktop \([0-9a-f]{8}\)$/.test(derived), derived);
check('the same root always → the same name', secretServiceFor(scratch) === derived && secretServiceFor(path.join(scratch, '.')) === derived);
check('two roots → two names', secretServiceFor(other) !== derived, secretServiceFor(other));
const link = path.join(other, 'link');
fs.symlinkSync(scratch, link, process.platform === 'win32' ? 'junction' : 'dir'); // a junction needs no admin rights
check('a symlink to a root → that root\'s name', secretServiceFor(link) === derived);
check('a root equal to the default passed in → the old name', secretServiceFor(scratch, link) === SECRET_SERVICE);
if (fs.existsSync(scratch.toUpperCase()) && scratch.toUpperCase() !== scratch) {
  check('a differently cased spelling (case-insensitive disk) → the same name', secretServiceFor(scratch.toUpperCase()) === derived);
}

// The real OS store (on by default on Windows, WGPT_SECRETS_REAL=1 elsewhere):
// createSecretStorage() exactly as the sidecar builds it, so on Windows that
// is Credential Manager behind the chunking. The bundle goes inside
// apps/desktop so the native @napi-rs/keyring resolves.
if (process.platform === 'win32' || process.env.WGPT_SECRETS_REAL === '1') {
  const liveOut = path.join(root, '.cache', 'secrets-live-test.cjs');
  fs.mkdirSync(path.dirname(liveOut), { recursive: true });
  await esbuild.build({ entryPoints: [path.join(root, 'sidecar/host/secrets.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: liveOut, logLevel: 'error', external: ['@napi-rs/keyring'] });
  const live = createRequire(import.meta.url)(liveOut);
  // A scratch profile's service, never the installed app's.
  const service = live.secretServiceFor(scratch);
  if (service === live.SECRET_SERVICE) throw new Error('refusing to probe the installed app\'s keychain service');
  const { backendKind, storage } = live.createSecretStorage(service);
  check('real store: the OS keychain loaded', backendKind === 'keychain', `${backendKind}, service "${service}"`);
  const key = `ci-probe-${process.pid}`;
  await storage.store(key, msal);
  check('real store: 32 KB value round-trips', (await storage.get(key)) === msal);
  await storage.store(key, 'small');
  check('real store: overwrite with a small value', (await storage.get(key)) === 'small');
  await storage.delete(key);
  check('real store: delete', (await storage.get(key)) === undefined);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
