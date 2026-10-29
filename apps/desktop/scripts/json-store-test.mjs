#!/usr/bin/env node
/** Regression: node apps/desktop/scripts/json-store-test.mjs */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-json-store-'));
const require = createRequire(import.meta.url);
const nativeFs = require('node:fs');
const originalWrite = nativeFs.writeFileSync;
const originalRename = nativeFs.renameSync;
try {
  const bundle = path.join(temp, 'stores.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'sidecar/host/stores.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error' });
  const { JsonStore, memento } = require(bundle);
  const file = path.join(temp, 'state.json');
  const status = [];
  const store = new JsonStore(file, (savedFile, error) => status.push({ file: savedFile, error }));
  await store.update('draft', 'last saved draft');
  const savedBytes = fs.readFileSync(file, 'utf8');

  const diskFull = Object.assign(new Error('injected full disk'), { code: 'ENOSPC' });
  nativeFs.writeFileSync = (target, ...args) => {
    if (target === `${file}.${process.pid}.tmp`) throw diskFull;
    return originalWrite(target, ...args);
  };
  const batch = await Promise.allSettled([store.update('draft', 'unsaved draft'), memento(store).update('setting', true)]);
  assert(batch.every((result) => result.status === 'rejected' && result.reason === diskFull));
  assert.equal(fs.readFileSync(file, 'utf8'), savedBytes);
  assert.equal(store.get('draft'), 'unsaved draft');
  assert.equal(status.at(-1).error, diskFull);
  console.log('PASS a failed coalesced save rejects every caller and preserves the last saved file');

  const pending = store.update('later', 42);
  assert.throws(() => store.flushSync(), (error) => error === diskFull);
  await assert.rejects(pending, (error) => error === diskFull);
  assert.throws(() => store.replaceAll({ draft: 'replacement draft' }), (error) => error === diskFull);
  assert.equal(fs.readFileSync(file, 'utf8'), savedBytes);
  console.log('PASS explicit flush and synchronous replacement report failures');

  nativeFs.writeFileSync = originalWrite;
  const denied = Object.assign(new Error('injected rename denied'), { code: 'EACCES' });
  nativeFs.renameSync = (source, target) => {
    if (target === file) throw denied;
    return originalRename(source, target);
  };
  await assert.rejects(store.update('setting', false), (error) => error === denied);
  assert.equal(fs.readFileSync(file, 'utf8'), savedBytes);
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
  console.log('PASS rename failure preserves saved data and cleans the temporary file');

  nativeFs.renameSync = originalRename;
  await store.update('recovered', true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { draft: 'replacement draft', setting: false, recovered: true });
  assert.deepEqual(status.at(-1), { file, error: undefined });
  const notices = status.length;
  await store.update('next', 'saved');
  assert.equal(status.length, notices);
  console.log('PASS a later successful save persists pending changes and clears the failure status');

  // Exercise a real filesystem error as well as the injected disk/rename errors.
  const blocked = path.join(temp, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'state.json'), '{}');
  const other = new JsonStore(path.join(blocked, 'state.json'));
  fs.rmSync(blocked, { recursive: true });
  await assert.rejects(other.update('draft', 'not saved'), { code: 'ENOENT' });
  fs.mkdirSync(blocked);
  await other.update('retry', true);
  assert.deepEqual(JSON.parse(fs.readFileSync(other.file, 'utf8')), { draft: 'not saved', retry: true });
  console.log('PASS a real filesystem failure rejects and can recover without discarding edits');
} finally {
  nativeFs.writeFileSync = originalWrite;
  nativeFs.renameSync = originalRename;
  fs.rmSync(temp, { recursive: true, force: true });
}
