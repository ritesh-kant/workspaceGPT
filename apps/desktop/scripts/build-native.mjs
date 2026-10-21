#!/usr/bin/env node
/**
 * Compiles the desktop's native helpers (macOS only) into dist/bin/.
 *
 *   node scripts/build-native.mjs [--target darwin-arm64] [--require]
 *
 * Today that is wgpt-dictate (native/wgpt-dictate.swift), the dictation helper
 * the sidecar starts (sidecar/host/dictation.ts), and wgpt-calls
 * (native/wgpt-calls.swift), the call-detection helper for call notes
 * (sidecar/host/callDetection.ts), and wgpt-notes (native/wgpt-notes.swift),
 * which records and transcribes a call (sidecar/host/callRecorder.ts). Without them the composer shows no mic
 * button and call notes reports itself unavailable, so a dev build on a machine
 * without the Swift toolchain just skips them; --require (the release stage)
 * makes that an error.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget } from './fetch-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const target = argOf('target') ?? hostTarget();
const required = process.argv.includes('--require');
const [platform, arch] = target.split('-');

const skip = (why) => {
  if (required) throw new Error(`cannot build the native helpers: ${why}`);
  console.log(`[native] skipped: ${why}`);
  process.exit(0);
};
if (platform !== 'darwin') skip(`nothing to build for ${target}`);
if (process.platform !== 'darwin') skip('macOS helpers are built on macOS');

const out = path.join(root, 'dist/bin');
fs.mkdirSync(out, { recursive: true });
// macOS 12 is the app's floor (tauri.conf.json); the helper checks for newer APIs at run time.
const triple = `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`;
for (const helper of ['wgpt-dictate', 'wgpt-calls', 'wgpt-notes']) {
  const r = spawnSync('swiftc', ['-O', '-swift-version', '5', '-target', triple, `native/${helper}.swift`, '-o', path.join(out, helper)], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.error?.code === 'ENOENT') skip('swiftc is not installed (xcode-select --install)');
  if (r.status !== 0) throw new Error(`swiftc failed building ${helper}`);
  console.log(`[native] dist/bin/${helper} (${triple})`);
}
