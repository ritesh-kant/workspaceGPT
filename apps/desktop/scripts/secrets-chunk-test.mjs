#!/usr/bin/env node
/**
 * The Windows secret chunking (sidecar/host/secrets.ts) against a fake
 * Credential Manager that rejects blobs over 1280 UTF-16 units, as the real
 * one does. Runs on any OS: node scripts/secrets-chunk-test.mjs
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
const { chunked, memoryBackend, splitForChunks } = createRequire(import.meta.url)(out);

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

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
